//! The HUD's half of the latency budget (docs/RAIL-PLAN.md §3.3, "IPC to
//! HUD + query 6-9 players' rollups < 10 ms"): from a `hand_imported`
//! message's arrival to the table's rollups re-read, in microseconds, over
//! the last [`WINDOW`] re-reads. Reported in every health answer and per
//! table in `table_updated`.

use std::collections::VecDeque;
use std::time::Duration;

use rail_hud_ipc::protocol::LatencySummary;

/// Re-reads kept for the percentiles.
pub const WINDOW: usize = 512;

#[derive(Debug, Default)]
pub struct Latencies {
    recent: VecDeque<u64>,
    count: u64,
}

/// A duration in whole microseconds (saturating).
pub fn micros(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

impl Latencies {
    pub fn record(&mut self, duration: Duration) {
        if self.recent.len() == WINDOW {
            self.recent.pop_front();
        }
        self.recent.push_back(micros(duration));
        self.count += 1;
    }

    pub fn summary(&self) -> LatencySummary {
        let mut sorted: Vec<u64> = self.recent.iter().copied().collect();
        sorted.sort_unstable();
        let at = |percent: usize| {
            sorted
                .get(sorted.len().saturating_sub(1) * percent / 100)
                .copied()
                .unwrap_or(0)
        };
        LatencySummary {
            count: self.count,
            p50_us: at(50),
            p95_us: at(95),
            max_us: sorted.last().copied().unwrap_or(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_over_the_recent_window() {
        let mut latencies = Latencies::default();
        assert_eq!(latencies.summary(), LatencySummary::default());
        for us in 1..=100 {
            latencies.record(Duration::from_micros(us));
        }
        let summary = latencies.summary();
        assert_eq!(
            (
                summary.count,
                summary.p50_us,
                summary.p95_us,
                summary.max_us
            ),
            (100, 50, 95, 100)
        );
        for _ in 0..WINDOW {
            latencies.record(Duration::from_micros(7));
        }
        let summary = latencies.summary();
        assert_eq!(summary.count, 100 + 512);
        assert_eq!((summary.p50_us, summary.max_us), (7, 7), "old ones out");
    }
}

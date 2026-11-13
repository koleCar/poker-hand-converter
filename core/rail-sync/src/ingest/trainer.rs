//! The Trainer's answers from the desktop app, kept in the account
//! (`record_trainer_results(p_rows)`,
//! `supabase/migrations/20270208090000_analysis_training.sql`): the same rows
//! the web's trainer writes (`web/src/lib/db/training.ts`), so the study plan
//! counts an answer given in the app like one given on the web.
//!
//! The server takes at most [`TRAINER_ROWS_PER_CALL`] rows a call, and one
//! row that breaks a column check fails the whole call; so every row is held
//! to the table's checks here first ([`TrainerResultRow::checked`]) and a
//! bad one is dropped rather than sent.

use serde::{Deserialize, Serialize};

use super::{IngestClient, IngestError, TokenSource, with_token};
use crate::auth::Secret;

/// Rows per `record_trainer_results` call (the server's limit).
pub const TRAINER_ROWS_PER_CALL: usize = 50;

const MODES: [&str; 3] = ["preflop", "flop", "river"];
const GRADES: [&str; 5] = ["perfect", "good", "inaccurate", "mistake", "blunder"];

/// One graded answer, as the server stores it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrainerResultRow {
    pub mode: String,
    pub family: String,
    #[serde(default)]
    pub spot: String,
    #[serde(default)]
    pub position: Option<String>,
    #[serde(default)]
    pub hand_class: Option<String>,
    pub grade: String,
    pub ev_loss_bb: f64,
    pub ev_loss_pot: f64,
    pub score: f64,
}

/// `^[a-z0-9][a-z0-9-]{0,39}$`
fn is_family(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 40
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `^[A-Z0-9+]{1,8}$`
fn is_position(text: &str) -> bool {
    (1..=8).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'+')
}

/// `^[2-9TJQKA]{2}[so]?$`
fn is_hand_class(text: &str) -> bool {
    let bytes = text.as_bytes();
    let rank = |b: u8| matches!(b, b'2'..=b'9' | b'T' | b'J' | b'Q' | b'K' | b'A');
    match bytes.len() {
        2 => rank(bytes[0]) && rank(bytes[1]),
        3 => rank(bytes[0]) && rank(bytes[1]) && matches!(bytes[2], b's' | b'o'),
        _ => false,
    }
}

fn clamp(value: f64, max: f64) -> Option<f64> {
    value.is_finite().then(|| value.clamp(0.0, max))
}

impl TrainerResultRow {
    /// The row as the table's checks take it (an empty position or hand
    /// class becomes none, the numbers clamped to their ranges), or `None`
    /// when a check would refuse it.
    pub fn checked(&self) -> Option<Self> {
        if !MODES.contains(&self.mode.as_str()) || !GRADES.contains(&self.grade.as_str()) {
            return None;
        }
        if !is_family(&self.family) || self.spot.chars().count() > 200 {
            return None;
        }
        let position = match self.position.as_deref() {
            None | Some("") => None,
            Some(p) if is_position(p) => Some(p.to_owned()),
            Some(_) => return None,
        };
        let hand_class = match self.hand_class.as_deref() {
            None | Some("") => None,
            Some(h) if is_hand_class(h) => Some(h.to_owned()),
            Some(_) => return None,
        };
        Some(Self {
            mode: self.mode.clone(),
            family: self.family.clone(),
            spot: self.spot.clone(),
            position,
            hand_class,
            grade: self.grade.clone(),
            ev_loss_bb: clamp(self.ev_loss_bb, 1000.0)?,
            // An unbounded loss (a fold of the nuts) is the whole pot, as the web sends it.
            ev_loss_pot: clamp(self.ev_loss_pot, 100.0).unwrap_or(1.0),
            score: clamp(self.score, 100.0)?,
        })
    }
}

#[derive(Deserialize)]
struct Inserted {
    inserted: Option<u64>,
}

impl IngestClient {
    /// Keep up to [`TRAINER_ROWS_PER_CALL`] answers; the number kept. Rows a
    /// check would refuse are left out (and not counted).
    pub async fn record_trainer_results(
        &self,
        token: &Secret,
        rows: &[TrainerResultRow],
    ) -> Result<u64, IngestError> {
        let rows: Vec<TrainerResultRow> = rows
            .iter()
            .filter_map(TrainerResultRow::checked)
            .take(TRAINER_ROWS_PER_CALL)
            .collect();
        if rows.is_empty() {
            return Ok(0);
        }
        let body = serde_json::json!({ "p_rows": rows }).to_string();
        let bytes = self.call(token, "record_trainer_results", body).await?;
        let answer: Inserted = serde_json::from_slice(&bytes).map_err(|_| {
            IngestError::Transient("unreadable record_trainer_results answer".into())
        })?;
        Ok(answer.inserted.unwrap_or(0))
    }

    /// [`IngestClient::record_trainer_results`] with the account's token.
    pub async fn record_trainer_results_as(
        &self,
        account: &impl TokenSource,
        rows: &[TrainerResultRow],
    ) -> Result<u64, IngestError> {
        with_token(account, |token| async move {
            self.record_trainer_results(&token, rows).await
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::TrainerResultRow;

    fn row() -> TrainerResultRow {
        TrainerResultRow {
            mode: "preflop".into(),
            family: "vs-open".into(),
            spot: "fffr".into(),
            position: Some("BB".into()),
            hand_class: Some("AKs".into()),
            grade: "mistake".into(),
            ev_loss_bb: 1.25,
            ev_loss_pot: 0.3,
            score: 40.0,
        }
    }

    #[test]
    fn a_row_the_table_takes_goes_as_it_is() {
        assert_eq!(row().checked(), Some(row()));
        let nine = TrainerResultRow {
            position: Some("UTG+1".into()),
            hand_class: Some("72".into()),
            ..row()
        };
        assert!(nine.checked().is_some());
    }

    #[test]
    fn empty_fields_become_none_and_numbers_are_clamped() {
        let loose = TrainerResultRow {
            position: Some(String::new()),
            hand_class: Some(String::new()),
            ev_loss_bb: 5000.0,
            ev_loss_pot: f64::INFINITY,
            score: -3.0,
            ..row()
        };
        let checked = loose.checked().expect("kept");
        assert_eq!(checked.position, None);
        assert_eq!(checked.hand_class, None);
        assert_eq!(checked.ev_loss_bb, 1000.0);
        assert_eq!(checked.ev_loss_pot, 1.0);
        assert_eq!(checked.score, 0.0);
    }

    #[test]
    fn a_row_a_check_would_refuse_is_dropped() {
        let bad = [
            TrainerResultRow {
                mode: "turn".into(),
                ..row()
            },
            TrainerResultRow {
                grade: "great".into(),
                ..row()
            },
            TrainerResultRow {
                family: "Vs Open".into(),
                ..row()
            },
            TrainerResultRow {
                family: String::new(),
                ..row()
            },
            TrainerResultRow {
                spot: "x".repeat(201),
                ..row()
            },
            TrainerResultRow {
                position: Some("bb".into()),
                ..row()
            },
            TrainerResultRow {
                hand_class: Some("AKx".into()),
                ..row()
            },
            TrainerResultRow {
                ev_loss_bb: f64::NAN,
                ..row()
            },
        ];
        for row in bad {
            assert_eq!(row.checked(), None, "{row:?}");
        }
    }
}

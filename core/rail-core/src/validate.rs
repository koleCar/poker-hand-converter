//! The hand validator (`frontend/src/lib/phf/validate.ts`): report types now,
//! the checks in R0.5b.
//!
//! The pipeline ([`crate::convert`](mod@crate::convert)) already calls [`validate_hand`] through
//! [`HandChecks`](crate::convert::HandChecks), exactly where `convertAny` calls
//! `validateHand`; R0.5b replaces the body below and nothing else moves.

/// `Severity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Severity {
    Error,
    Warning,
}

/// A value in a problem's `context` (`Record<string, string | number>`; every
/// number the validator puts there is an integer).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ContextValue {
    Text(String),
    Integer(i64),
}

/// `ValidationProblem`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ValidationProblem {
    /// Short machine code; doubles as the `reason` of a validate-stage
    /// `ConversionFailure`.
    pub code: String,
    pub message: String,
    pub severity: Severity,
    /// Player, seat, action index - in insertion order, as the TypeScript
    /// object literal has them. `None` is an absent `context`.
    pub context: Option<Vec<(String, ContextValue)>>,
}

/// `ValidationReport`: every problem in the order found; `ok`, `errors` and
/// `warnings` are views of it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct ValidationReport {
    pub problems: Vec<ValidationProblem>,
}

impl ValidationReport {
    /// `report.ok`: no errors.
    pub fn ok(&self) -> bool {
        self.errors().next().is_none()
    }

    /// `report.errors`.
    pub fn errors(&self) -> impl Iterator<Item = &ValidationProblem> {
        self.problems
            .iter()
            .filter(|p| p.severity == Severity::Error)
    }

    /// `report.warnings`.
    pub fn warnings(&self) -> impl Iterator<Item = &ValidationProblem> {
        self.problems
            .iter()
            .filter(|p| p.severity == Severity::Warning)
    }
}

/// `validateHand`. **R0.5b**: not ported yet. It panics rather than passing
/// every hand, so nothing can be stored unvalidated in the meantime; with no
/// parser registered (R0.5a) the pipeline never gets this far.
pub fn validate_hand(_hand: &crate::phf::PhfHand) -> ValidationReport {
    unimplemented!("validateHand is ported in R0.5b")
}

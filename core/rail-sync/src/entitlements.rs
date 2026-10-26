//! (R6.4) What the desktop app may use: the server's answer about the
//! account's plan, kept for offline use, and the rules that turn it into
//! the app's **effective** entitlements.
//!
//! **The server is the gate for everything that touches the cloud** (R6.2:
//! sync, the pull, HUD layouts, every Pro function refuses with `PT402`).
//! What this decides is the **local** Pro features - the HUD, the analysis
//! and the full reports run on the user's own machine over the local store,
//! so only the app can hold them back. The cached answer lives in the local
//! store's `kv` (the SQLite database, not a settings file), unsigned: it is
//! the user's own machine, and anything that reaches the account is checked
//! again by the server.
//!
//! **The rules** ([`effective`]), in order (owner's R6.4 decision,
//! 2026-10-26):
//!
//! 1. **Is enforcement on?** The newest answer wins: an account check
//!    (`my_entitlements().enforced`) or the public flag
//!    (`billing_enforced()`, anon, for an app that is not signed in).
//!    Never told: **unknown, treated as off** - today's behaviour, so a
//!    fresh install that has never been online, or a server without the
//!    function yet, keeps every feature (see [`Enforcement::Unknown`]).
//! 2. **Off** (or unknown): everything is open, signed in or not.
//! 3. **On, not signed in**: Free.
//! 4. **On, signed in, no usable check for this account** (none yet, another
//!    account's, or one taken while enforcement was off - it says nothing
//!    about the plan): Free until the next successful check.
//! 5. **On, signed in, checked**: the check holds for the server's
//!    `offlineGraceDays` (14) from when it was fetched. Within it, the plan
//!    it said - Pro with its features, or Free. Past it (or a clock set
//!    back by more than a day before the check): Free, "reconnect to keep
//!    Pro", until the next successful check.
//!
//! A failed check (offline, the server down) changes nothing: the last
//! answers stand and their clock keeps running.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A day in ms.
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The server allows 0-90 days (`billing_settings.offline_grace_days`).
pub const MAX_GRACE_DAYS: u32 = 90;
/// What R6.2 ships, for a check that does not say.
pub const DEFAULT_GRACE_DAYS: u32 = 14;
/// A check from the future by more than this: the clock was set back.
const CLOCK_SLACK_MS: i64 = DAY_MS;

/// The store's `kv` keys.
pub const ACCOUNT_KEY: &str = "entitlements.account";
pub const PUBLIC_KEY: &str = "entitlements.public";

/// The features a plan grants (`plan_limits.features`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub desktop_sync: bool,
    pub hud: bool,
    pub reports_full: bool,
    pub analysis: bool,
    pub learn: bool,
}

impl Features {
    pub const ALL: Self = Self {
        desktop_sync: true,
        hud: true,
        reports_full: true,
        analysis: true,
        learn: true,
    };
    pub const NONE: Self = Self {
        desktop_sync: false,
        hud: false,
        reports_full: false,
        analysis: false,
        learn: false,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Plan {
    Free,
    Pro,
}

/// What the app keeps of `my_entitlements()`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntitlements {
    pub plan: Plan,
    /// `not_enforced`, `subscription`, `grace`, `granted`, ... (R6.2).
    pub reason: String,
    pub enforced: bool,
    pub features: Features,
    /// Stored hands the plan holds; `None` = unlimited.
    pub hand_cap: Option<u64>,
    pub hands_stored: u64,
    /// How long the app may trust this answer offline.
    pub offline_grace_days: u32,
    /// The plan holds at least until then (ISO time, for display).
    pub valid_until: Option<String>,
}

impl ServerEntitlements {
    /// `my_entitlements()`'s JSON, field by field; `None` when it is not an
    /// object with a `plan`. Unknown values read as the safe one: a feature
    /// is granted only by a literal `true`.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        let row = value.as_object()?;
        let plan = match row.get("plan")?.as_str()? {
            "pro" => Plan::Pro,
            _ => Plan::Free,
        };
        let enforced = row.get("enforced").and_then(Value::as_bool) == Some(true);
        let features = row.get("features").and_then(Value::as_object);
        let flag =
            |name: &str| features.and_then(|f| f.get(name)).and_then(Value::as_bool) == Some(true);
        let grace = row
            .get("offlineGraceDays")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_GRACE_DAYS, |days| {
                u32::try_from(days).unwrap_or(MAX_GRACE_DAYS)
            });
        Some(Self {
            plan,
            reason: row
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(40)
                .collect(),
            enforced,
            features: Features {
                desktop_sync: flag("desktop_sync"),
                hud: flag("hud"),
                reports_full: flag("reports_full"),
                analysis: flag("analysis"),
                learn: flag("learn"),
            },
            hand_cap: features
                .and_then(|f| f.get("hand_cap"))
                .and_then(Value::as_u64),
            hands_stored: row
                .get("usage")
                .and_then(|u| u.get("handsStored"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            offline_grace_days: grace.min(MAX_GRACE_DAYS),
            valid_until: row
                .get("validUntil")
                .and_then(Value::as_str)
                .map(|t| t.chars().take(40).collect()),
        })
    }
}

/// A successful `my_entitlements()` for one account, as kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCheck {
    pub user_id: String,
    /// When it was fetched (this machine's clock, Unix ms).
    pub fetched_at_ms: i64,
    pub entitlements: ServerEntitlements,
}

/// A successful `billing_enforced()`, as kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementCheck {
    pub enforced: bool,
    pub fetched_at_ms: i64,
}

/// Whether paid plans are enforced, as far as this app knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Enforcement {
    /// Never told (never online, or a server without R6.4's flag). Treated
    /// as **off**: the trade-off is that a machine kept offline from the
    /// day it was installed keeps the local Pro features after launch, in
    /// exchange for never locking anyone out of what works today because
    /// the network was down on first start. Its first look online settles
    /// it, and the cloud features are refused by the server regardless.
    Unknown,
    Off,
    On,
}

/// The effective plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EffectivePlan {
    /// Enforcement off or unknown: everything is open.
    Open,
    Pro,
    Free,
}

/// Why, and what the user can do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    EnforcementUnknown,
    NotEnforced,
    /// Enforced, nobody signed in: "Sign in".
    SignedOut,
    /// Enforced, signed in, no usable check yet: "Reconnect" (it checks by
    /// itself when online).
    NotChecked,
    /// A check within the grace period said Pro.
    Pro,
    /// A check within the grace period said Free: "Upgrade".
    Free,
    /// The last check is older than the grace period: "Reconnect to keep
    /// Pro".
    GraceExpired,
}

/// What the app may use now, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
    pub plan: EffectivePlan,
    pub reason: Reason,
    pub enforcement: Enforcement,
    pub features: Features,
    /// Pro holds offline until then (Unix ms), when it came from a check.
    pub pro_until_ms: Option<i64>,
    /// The account check the answer rests on (Unix ms), if any.
    pub checked_at_ms: Option<i64>,
}

impl Effective {
    /// Enforcement is on and the plan lacks something: a lock may show.
    pub fn restricted(&self) -> bool {
        self.plan == EffectivePlan::Free
    }
}

/// What [`effective`] reads.
#[derive(Debug, Clone, Copy)]
pub struct Inputs<'a> {
    pub now_ms: i64,
    /// The account signed in now (its id), if any.
    pub user_id: Option<&'a str>,
    pub account: Option<&'a AccountCheck>,
    pub public: Option<&'a EnforcementCheck>,
}

/// The rules of the module documentation.
pub fn effective(inputs: Inputs<'_>) -> Effective {
    let open = |reason, enforcement| Effective {
        plan: EffectivePlan::Open,
        reason,
        enforcement,
        features: Features::ALL,
        pro_until_ms: None,
        checked_at_ms: None,
    };
    let free = |reason, checked_at_ms| Effective {
        plan: EffectivePlan::Free,
        reason,
        enforcement: Enforcement::On,
        features: Features::NONE,
        pro_until_ms: None,
        checked_at_ms,
    };

    // 1. The newest word on enforcement, from either source (another
    // account's check still says whether the server enforces).
    let from_account = inputs
        .account
        .map(|a| (a.fetched_at_ms, a.entitlements.enforced));
    let from_public = inputs.public.map(|p| (p.fetched_at_ms, p.enforced));
    let newest = match (from_account, from_public) {
        (Some(a), Some(p)) => Some(if p.0 > a.0 { p } else { a }),
        (a, p) => a.or(p),
    };
    match newest {
        None => return open(Reason::EnforcementUnknown, Enforcement::Unknown),
        Some((_, false)) => return open(Reason::NotEnforced, Enforcement::Off),
        Some((_, true)) => {}
    }

    // 3. Nobody signed in.
    let Some(user_id) = inputs.user_id else {
        return free(Reason::SignedOut, None);
    };
    // 4. A check of this account, taken while enforcement was on.
    let Some(check) = inputs
        .account
        .filter(|a| a.user_id == user_id && a.entitlements.enforced)
    else {
        return free(Reason::NotChecked, None);
    };
    // 5. Within its grace period.
    let grace_days = check.entitlements.offline_grace_days.min(MAX_GRACE_DAYS);
    let until = check
        .fetched_at_ms
        .saturating_add(i64::from(grace_days).saturating_mul(DAY_MS));
    let set_back = check.fetched_at_ms > inputs.now_ms.saturating_add(CLOCK_SLACK_MS);
    if set_back || inputs.now_ms > until {
        return free(Reason::GraceExpired, Some(check.fetched_at_ms));
    }
    match check.entitlements.plan {
        Plan::Pro => Effective {
            plan: EffectivePlan::Pro,
            reason: Reason::Pro,
            enforcement: Enforcement::On,
            features: check.entitlements.features,
            pro_until_ms: Some(until),
            checked_at_ms: Some(check.fetched_at_ms),
        },
        Plan::Free => Effective {
            features: check.entitlements.features,
            ..free(Reason::Free, Some(check.fetched_at_ms))
        },
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;

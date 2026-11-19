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
//!
//! Free is [`Features::FREE`]: desktop sync (free since the free tier,
//! 2026-11-19; the server caps the hands a day and the library instead),
//! nothing else. The solver's flops a day and the hands a day are the
//! server's to count ([`ServerEntitlements::daily_flop_cap`],
//! [`ServerEntitlements::daily_hand_cap`]); table tiling and the RNG are
//! never gated.
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
    /// Every solver flop (Free: a few distinct flops a UTC day). Absent
    /// from an answer kept before the free tier: false.
    #[serde(default)]
    pub solver_unlimited: bool,
    /// The solver's nodelock.
    #[serde(default)]
    pub nodelock: bool,
}

impl Features {
    pub const ALL: Self = Self {
        desktop_sync: true,
        hud: true,
        reports_full: true,
        analysis: true,
        learn: true,
        solver_unlimited: true,
        nodelock: true,
    };
    pub const NONE: Self = Self {
        desktop_sync: false,
        hud: false,
        reports_full: false,
        analysis: false,
        learn: false,
        solver_unlimited: false,
        nodelock: false,
    };
    /// What Free includes (`plan_limits.features` of `free`): desktop sync.
    /// Also what the app falls back to with no usable check.
    pub const FREE: Self = Self {
        desktop_sync: true,
        ..Self::NONE
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
    /// (Free tier) Hands the plan saves a UTC day, web and desktop together;
    /// `None` = unlimited (Pro, or enforcement off).
    #[serde(default)]
    pub daily_hand_cap: Option<u64>,
    /// Distinct solver flops the plan opens a UTC day; `None` = unlimited.
    #[serde(default)]
    pub daily_flop_cap: Option<u32>,
    /// Hands saved today (counted only while enforcement is on).
    #[serde(default)]
    pub hands_today: u64,
    /// Today's solver flops, canonical keys ([`flop_key`]), in the order
    /// they were opened.
    #[serde(default)]
    pub flops_today: Vec<String>,
    /// When the day's counts start again (Unix ms, the next 00:00 UTC).
    #[serde(default)]
    pub day_resets_at_ms: Option<i64>,
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
        let usage = row.get("usage").and_then(Value::as_object);
        let limits = row.get("limits").and_then(Value::as_object);
        let limit = |name: &str| limits.and_then(|l| l.get(name)).and_then(Value::as_u64);
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
                solver_unlimited: flag("solver_unlimited"),
                nodelock: flag("nodelock"),
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
            daily_hand_cap: limit("dailyHandCap"),
            daily_flop_cap: limit("dailyFlopCap").map(|cap| u32::try_from(cap).unwrap_or(u32::MAX)),
            hands_today: usage
                .and_then(|u| u.get("handsToday"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            flops_today: usage
                .and_then(|u| u.get("flopsToday"))
                .map(flops_of)
                .unwrap_or_default(),
            day_resets_at_ms: usage
                .and_then(|u| u.get("dayResetsAt"))
                .and_then(Value::as_str)
                .and_then(utc_midnight_ms),
        })
    }
}

/// A list of flops as the server gives it (`flopsToday`, `flops`): the
/// canonical keys, anything else left out, at most 64.
pub fn flops_of(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|flops| {
            flops
                .iter()
                .filter_map(Value::as_str)
                .filter_map(flop_key)
                .take(64)
                .collect()
        })
        .unwrap_or_default()
}

/// The canonical flop key (`solver_flop_key()` on the server): three
/// distinct cards `<rank><suit>` (ranks `AKQJT98765432`, suits `shdc`),
/// sorted by rank descending, then suit `s h d c`: `Ks7d2c`. Any order and
/// case, spaces and commas ignored; `None` when it is not three cards.
pub fn flop_key(text: &str) -> Option<String> {
    const RANKS: &str = "AKQJT98765432";
    const SUITS: &str = "shdc";
    if text.len() > 32 {
        return None;
    }
    let chars: Vec<char> = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ',')
        .collect();
    if chars.len() != 6 {
        return None;
    }
    let mut cards: Vec<(usize, usize)> = Vec::with_capacity(3);
    for pair in chars.chunks(2) {
        let rank = RANKS.find(pair[0].to_ascii_uppercase())?;
        let suit = SUITS.find(pair[1].to_ascii_lowercase())?;
        if cards.contains(&(rank, suit)) {
            return None;
        }
        cards.push((rank, suit));
    }
    cards.sort_unstable();
    Some(
        cards
            .into_iter()
            .flat_map(|(rank, suit)| {
                [
                    RANKS.as_bytes()[rank] as char,
                    SUITS.as_bytes()[suit] as char,
                ]
            })
            .collect(),
    )
}

/// `YYYY-MM-DDT00:00:00Z` (the server's `dayResetsAt`, `resetsAt`) as Unix
/// ms; `None` for anything else.
pub fn utc_midnight_ms(text: &str) -> Option<i64> {
    let date = text.strip_suffix("T00:00:00Z")?;
    let mut parts = date.splitn(3, '-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    if date.len() != 10 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from 1970-01-01 (Howard Hinnant's days_from_civil).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * DAY_MS)
}

/// The next 00:00 UTC after `now_ms` (when the server's day starts again).
pub fn next_utc_midnight_ms(now_ms: i64) -> i64 {
    (now_ms.div_euclid(DAY_MS) + 1) * DAY_MS
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
        features: Features::FREE,
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

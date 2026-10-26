use super::*;

const NOW: i64 = 1_800_000_000_000;
const HOUR: i64 = 60 * 60 * 1000;
const ME: &str = "00000000-0000-0000-0000-0000000000a1";
const OTHER: &str = "00000000-0000-0000-0000-0000000000b2";

/// `my_entitlements()` as R6.2 answers it.
fn answer(plan: &str, enforced: bool, grace: u32) -> String {
    let pro = plan == "pro" || !enforced;
    serde_json::json!({
        "plan": if enforced { plan } else { "pro" },
        "reason": if enforced { if pro { "subscription" } else { "free" } } else { "not_enforced" },
        "enforced": enforced,
        "features": {
            "library_unlimited": pro, "hand_cap": if pro { Value::Null } else { 10000.into() },
            "desktop_sync": pro, "hud": pro, "reports_full": pro, "analysis": pro, "learn": pro,
        },
        "usage": { "handsStored": 1234 },
        "limits": { "freeHandCap": 10000 },
        "subscription": { "plan": plan, "period": "month", "status": "active", "currentPeriodEnd": null },
        "earlyUser": { "is": true, "since": null, "discountPercent": 30 },
        "validUntil": "2027-01-01T00:00:00+00:00",
        "graceUntil": null,
        "offlineGraceDays": grace,
        "checkedAt": "2026-10-26T10:00:00+00:00",
    })
    .to_string()
}

fn check(user: &str, plan: &str, enforced: bool, fetched_at_ms: i64) -> AccountCheck {
    AccountCheck {
        user_id: user.to_owned(),
        fetched_at_ms,
        entitlements: ServerEntitlements::parse(answer(plan, enforced, 14).as_bytes()).unwrap(),
    }
}

fn public(enforced: bool, fetched_at_ms: i64) -> EnforcementCheck {
    EnforcementCheck {
        enforced,
        fetched_at_ms,
    }
}

fn eff(
    user: Option<&str>,
    account: Option<&AccountCheck>,
    public: Option<&EnforcementCheck>,
) -> Effective {
    effective(Inputs {
        now_ms: NOW,
        user_id: user,
        account,
        public,
    })
}

#[test]
fn the_server_answer_is_read_field_by_field() {
    let pro = ServerEntitlements::parse(answer("pro", true, 14).as_bytes()).unwrap();
    assert_eq!(pro.plan, Plan::Pro);
    assert!(pro.enforced);
    assert_eq!(pro.features, Features::ALL);
    assert_eq!(pro.hand_cap, None);
    assert_eq!(pro.hands_stored, 1234);
    assert_eq!(pro.offline_grace_days, 14);
    assert_eq!(pro.reason, "subscription");

    let free = ServerEntitlements::parse(answer("free", true, 14).as_bytes()).unwrap();
    assert_eq!((free.plan, free.features), (Plan::Free, Features::NONE));
    assert_eq!(free.hand_cap, Some(10_000));

    let off = ServerEntitlements::parse(answer("free", false, 14).as_bytes()).unwrap();
    assert!(!off.enforced);
    assert_eq!(off.plan, Plan::Pro, "while off every account is Pro");

    // Garbage, and the safe reading of odd values.
    assert_eq!(ServerEntitlements::parse(b"not json"), None);
    assert_eq!(ServerEntitlements::parse(b"[]"), None);
    assert_eq!(ServerEntitlements::parse(b"{}"), None);
    let odd = ServerEntitlements::parse(
        br#"{"plan":"platinum","enforced":"yes","features":{"hud":1,"analysis":"true"},"offlineGraceDays":9999}"#,
    )
    .unwrap();
    assert_eq!(odd.plan, Plan::Free, "an unknown plan is Free");
    assert!(!odd.enforced, "only a literal true");
    assert_eq!(odd.features, Features::NONE, "only a literal true");
    assert_eq!(odd.offline_grace_days, MAX_GRACE_DAYS);
    let none = ServerEntitlements::parse(br#"{"plan":"pro","enforced":true}"#).unwrap();
    assert_eq!(none.offline_grace_days, DEFAULT_GRACE_DAYS);
}

#[test]
fn enforcement_never_heard_of_is_off_signed_in_or_not() {
    for user in [None, Some(ME)] {
        let e = eff(user, None, None);
        assert_eq!(
            (e.plan, e.reason, e.enforcement, e.features),
            (
                EffectivePlan::Open,
                Reason::EnforcementUnknown,
                Enforcement::Unknown,
                Features::ALL
            )
        );
        assert!(!e.restricted());
    }
}

#[test]
fn enforcement_off_opens_everything() {
    // Told by the public flag, signed out.
    let e = eff(None, None, Some(&public(false, NOW - HOUR)));
    assert_eq!(
        (e.plan, e.reason),
        (EffectivePlan::Open, Reason::NotEnforced)
    );
    assert_eq!(e.features, Features::ALL);
    // Told by the account's own check (today: every account is Pro, off).
    let mine = check(ME, "free", false, NOW - HOUR);
    let e = eff(Some(ME), Some(&mine), None);
    assert_eq!(
        (e.plan, e.enforcement),
        (EffectivePlan::Open, Enforcement::Off)
    );
    // An old check (past any grace) while off: still open - nothing expires.
    let old = check(ME, "free", false, NOW - 400 * DAY_MS);
    assert_eq!(eff(Some(ME), Some(&old), None).plan, EffectivePlan::Open);
    assert_eq!(eff(None, Some(&old), None).plan, EffectivePlan::Open);
}

#[test]
fn enforced_and_signed_out_is_free() {
    let e = eff(None, None, Some(&public(true, NOW - HOUR)));
    assert_eq!(
        (e.plan, e.reason, e.enforcement, e.features),
        (
            EffectivePlan::Free,
            Reason::SignedOut,
            Enforcement::On,
            Features::NONE
        )
    );
    assert!(e.restricted());
    // A Pro check of the account that was signed in does not count once it
    // is signed out.
    let mine = check(ME, "pro", true, NOW - HOUR);
    assert_eq!(eff(None, Some(&mine), None).reason, Reason::SignedOut);
}

#[test]
fn a_fresh_pro_check_is_pro_until_the_grace_ends() {
    let mine = check(ME, "pro", true, NOW - 2 * HOUR);
    let e = eff(Some(ME), Some(&mine), None);
    assert_eq!((e.plan, e.reason), (EffectivePlan::Pro, Reason::Pro));
    assert_eq!(e.features, Features::ALL);
    assert_eq!(e.pro_until_ms, Some(NOW - 2 * HOUR + 14 * DAY_MS));
    assert_eq!(e.checked_at_ms, Some(NOW - 2 * HOUR));
    // The last moment of the grace period still counts...
    let edge = check(ME, "pro", true, NOW - 14 * DAY_MS);
    assert_eq!(eff(Some(ME), Some(&edge), None).plan, EffectivePlan::Pro);
    // ...a moment later it does not.
    let past = check(ME, "pro", true, NOW - 14 * DAY_MS - 1);
    let e = eff(Some(ME), Some(&past), None);
    assert_eq!(
        (e.plan, e.reason, e.features),
        (EffectivePlan::Free, Reason::GraceExpired, Features::NONE)
    );
    assert_eq!(e.checked_at_ms, Some(NOW - 14 * DAY_MS - 1));
}

#[test]
fn the_grace_period_is_the_servers() {
    let mut mine = check(ME, "pro", true, NOW - 3 * DAY_MS);
    mine.entitlements.offline_grace_days = 2;
    assert_eq!(
        eff(Some(ME), Some(&mine), None).reason,
        Reason::GraceExpired
    );
    mine.entitlements.offline_grace_days = 0;
    mine.fetched_at_ms = NOW;
    assert_eq!(
        eff(Some(ME), Some(&mine), None).reason,
        Reason::Pro,
        "a check this instant holds this instant"
    );
}

#[test]
fn a_free_check_is_free_with_an_upgrade() {
    let mine = check(ME, "free", true, NOW - HOUR);
    let e = eff(Some(ME), Some(&mine), None);
    assert_eq!(
        (e.plan, e.reason, e.features),
        (EffectivePlan::Free, Reason::Free, Features::NONE)
    );
    assert_eq!(e.pro_until_ms, None);
}

#[test]
fn another_accounts_check_tells_enforcement_but_not_the_plan() {
    let theirs = check(OTHER, "pro", true, NOW - HOUR);
    let e = eff(Some(ME), Some(&theirs), None);
    assert_eq!(
        (e.plan, e.reason),
        (EffectivePlan::Free, Reason::NotChecked)
    );
}

#[test]
fn a_check_taken_while_off_says_nothing_about_the_plan_once_on() {
    // Checked yesterday while off (Pro for everyone); the public flag says
    // enforcement went on since: the plan is not known until a new check.
    let mine = check(ME, "free", false, NOW - DAY_MS);
    let e = eff(Some(ME), Some(&mine), Some(&public(true, NOW - HOUR)));
    assert_eq!(
        (e.plan, e.reason),
        (EffectivePlan::Free, Reason::NotChecked)
    );
}

#[test]
fn the_newest_word_on_enforcement_wins() {
    // An older account check said on; a newer public look says off.
    let mine = check(ME, "free", true, NOW - DAY_MS);
    let e = eff(Some(ME), Some(&mine), Some(&public(false, NOW - HOUR)));
    assert_eq!(e.plan, EffectivePlan::Open);
    // A newer account check (on, Pro) over an older public "off".
    let mine = check(ME, "pro", true, NOW - HOUR);
    let e = eff(Some(ME), Some(&mine), Some(&public(false, NOW - DAY_MS)));
    assert_eq!(e.plan, EffectivePlan::Pro);
}

#[test]
fn a_clock_set_back_does_not_extend_pro() {
    let future = check(ME, "pro", true, NOW + 3 * DAY_MS);
    assert_eq!(
        eff(Some(ME), Some(&future), None).reason,
        Reason::GraceExpired
    );
    // Within the day's slack (a clock corrected by minutes or hours): kept.
    let near = check(ME, "pro", true, NOW + HOUR);
    assert_eq!(eff(Some(ME), Some(&near), None).reason, Reason::Pro);
}

#[test]
fn an_unreachable_server_changes_nothing_until_the_grace_ends() {
    // No new check is the same inputs with a later clock: Pro for 14 days
    // from the last successful check, whatever happened in between.
    let mine = check(ME, "pro", true, NOW);
    for days in [0, 1, 7, 13] {
        let e = effective(Inputs {
            now_ms: NOW + days * DAY_MS,
            user_id: Some(ME),
            account: Some(&mine),
            public: None,
        });
        assert_eq!(e.plan, EffectivePlan::Pro, "day {days}");
    }
    let e = effective(Inputs {
        now_ms: NOW + 14 * DAY_MS + 1,
        user_id: Some(ME),
        account: Some(&mine),
        public: None,
    });
    assert_eq!(e.reason, Reason::GraceExpired);
}

#[test]
fn the_kept_records_round_trip() {
    let mine = check(ME, "pro", true, NOW);
    let text = serde_json::to_string(&mine).unwrap();
    assert_eq!(serde_json::from_str::<AccountCheck>(&text).unwrap(), mine);
    let flag = public(true, NOW);
    let text = serde_json::to_string(&flag).unwrap();
    assert_eq!(
        serde_json::from_str::<EnforcementCheck>(&text).unwrap(),
        flag
    );
    // The window's shape.
    let shown = serde_json::to_value(eff(Some(ME), Some(&mine), None)).unwrap();
    assert_eq!(shown["plan"], "pro");
    assert_eq!(shown["reason"], "pro");
    assert_eq!(shown["enforcement"], "on");
    assert_eq!(shown["features"]["reportsFull"], true);
    let shown = serde_json::to_value(eff(None, None, None)).unwrap();
    assert_eq!(shown["reason"], "enforcementUnknown");
}

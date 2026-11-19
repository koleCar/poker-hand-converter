use super::*;

const NOW: i64 = 1_800_000_000_000;
const HOUR: i64 = 60 * 60 * 1000;
const ME: &str = "00000000-0000-0000-0000-0000000000a1";
const OTHER: &str = "00000000-0000-0000-0000-0000000000b2";

/// `my_entitlements()` as the free tier answers it
/// (`20271119110000_free_tier_limits.sql`).
fn answer(plan: &str, enforced: bool, grace: u32) -> String {
    let pro = plan == "pro" || !enforced;
    serde_json::json!({
        "plan": if enforced { plan } else { "pro" },
        "reason": if enforced { if pro { "subscription" } else { "free" } } else { "not_enforced" },
        "enforced": enforced,
        "features": {
            "library_unlimited": pro, "hand_cap": if pro { Value::Null } else { 10000.into() },
            "desktop_sync": true, "hud": pro, "reports_full": pro, "analysis": pro, "learn": pro,
            "solver_unlimited": pro, "nodelock": pro,
        },
        "usage": {
            "handsStored": 1234, "handsToday": if enforced { 120 } else { 0 },
            "flopsToday": if pro { serde_json::json!([]) } else { serde_json::json!(["Ks7d2c", "QhJh4s"]) },
            "dayResetsAt": "2027-01-15T00:00:00Z",
        },
        "limits": {
            "freeHandCap": 10000,
            "dailyHandCap": if pro { Value::Null } else { 500.into() },
            "dailyFlopCap": if pro { Value::Null } else { 3.into() },
        },
        "subscription": { "plan": plan, "period": "month", "status": "active", "currentPeriodEnd": null },
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

    assert_eq!((pro.daily_hand_cap, pro.daily_flop_cap), (None, None));
    assert!(pro.flops_today.is_empty());

    let free = ServerEntitlements::parse(answer("free", true, 14).as_bytes()).unwrap();
    assert_eq!((free.plan, free.features), (Plan::Free, Features::FREE));
    assert!(free.features.desktop_sync, "desktop sync is free");
    assert!(!free.features.solver_unlimited && !free.features.nodelock);
    assert_eq!(free.hand_cap, Some(10_000));
    assert_eq!(
        (free.daily_hand_cap, free.daily_flop_cap),
        (Some(500), Some(3))
    );
    assert_eq!(free.hands_today, 120);
    assert_eq!(free.flops_today, ["Ks7d2c", "QhJh4s"]);
    assert_eq!(
        free.day_resets_at_ms,
        utc_midnight_ms("2027-01-15T00:00:00Z")
    );

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
    assert_eq!((odd.daily_hand_cap, odd.hands_today), (None, 0));
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
            Features::FREE
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
        (EffectivePlan::Free, Reason::GraceExpired, Features::FREE)
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
        (EffectivePlan::Free, Reason::Free, Features::FREE)
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

#[test]
fn every_free_fallback_keeps_sync_on() {
    let theirs = check(OTHER, "pro", true, NOW - HOUR);
    let old = check(ME, "pro", true, NOW - 30 * DAY_MS);
    let on = public(true, NOW - HOUR);
    for (user, account) in [
        (None, None),
        (Some(ME), None),
        (Some(ME), Some(&theirs)),
        (Some(ME), Some(&old)),
    ] {
        let e = eff(user, account, Some(&on));
        assert_eq!(e.plan, EffectivePlan::Free);
        assert_eq!(e.features, Features::FREE, "{:?}", e.reason);
        assert!(e.features.desktop_sync);
        assert!(!e.features.hud && !e.features.nodelock && !e.features.solver_unlimited);
    }
}

#[test]
fn an_answer_kept_before_the_free_tier_still_reads() {
    // The shape an older app kept: no solver flags, no daily numbers.
    let text = r#"{"userId":"u","fetchedAtMs":1,"entitlements":{"plan":"pro","reason":"x","enforced":false,
        "features":{"desktopSync":true,"hud":true,"reportsFull":true,"analysis":true,"learn":true},
        "handCap":null,"handsStored":3,"offlineGraceDays":14,"validUntil":null}}"#;
    let kept: AccountCheck = serde_json::from_str(text).unwrap();
    assert!(!kept.entitlements.features.nodelock);
    assert_eq!(kept.entitlements.daily_hand_cap, None);
    assert!(kept.entitlements.flops_today.is_empty());
    // Kept while enforcement was off: everything stays open.
    let e = eff(Some("u"), Some(&kept), None);
    assert_eq!((e.plan, e.features), (EffectivePlan::Open, Features::ALL));
}

#[test]
fn flop_keys_are_the_servers() {
    for (given, key) in [
        ("Ks7d2c", "Ks7d2c"),
        ("2c Ks 7d", "Ks7d2c"),
        ("ks7D2C", "Ks7d2c"),
        ("Ks,7d,2c", "Ks7d2c"),
        ("AhAsAc", "AsAhAc"),
        ("2d2s2h", "2s2h2d"),
        ("Tc9cJc", "JcTc9c"),
    ] {
        assert_eq!(flop_key(given).as_deref(), Some(key), "{given}");
    }
    for bad in [
        "",
        "Ks7d",
        "Ks7d2c3h",
        "KsKs2c",
        "Kx7d2c",
        "1s7d2c",
        "K s 7 d 2",
    ] {
        assert_eq!(flop_key(bad), None, "{bad}");
    }
    let listed = flops_of(&serde_json::json!(["Ks7d2c", 3, "nope", "2c7dKs"]));
    assert_eq!(listed, ["Ks7d2c", "Ks7d2c"]);
}

#[test]
fn the_days_reset_reads_as_utc_midnight() {
    assert_eq!(utc_midnight_ms("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(utc_midnight_ms("1970-01-02T00:00:00Z"), Some(DAY_MS));
    // 2026-11-20 00:00 UTC.
    assert_eq!(
        utc_midnight_ms("2026-11-20T00:00:00Z"),
        Some(1_795_132_800_000)
    );
    assert_eq!(
        utc_midnight_ms("2024-03-01T00:00:00Z"),
        Some(1_709_251_200_000)
    );
    for bad in [
        "2026-11-20",
        "2026-11-20T01:00:00Z",
        "2026-13-01T00:00:00Z",
        "x",
    ] {
        assert_eq!(utc_midnight_ms(bad), None, "{bad}");
    }
    assert_eq!(
        next_utc_midnight_ms(1_795_132_800_000 - 1),
        1_795_132_800_000
    );
    assert_eq!(
        next_utc_midnight_ms(1_795_132_800_000),
        1_795_132_800_000 + DAY_MS
    );
}

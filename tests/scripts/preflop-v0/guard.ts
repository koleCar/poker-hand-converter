/**
 * The v0 runner's working-hours guard (docs/PREFLOP-PLAN.md §4.4): no solve
 * runs Monday to Friday 08:00-16:00 Europe/Zagreb, and a set is not started
 * if its estimated run would reach 08:00 on a weekday. Pure: the time is
 * passed in, the zone is the IANA one (summer time handled by `Intl`).
 */

export const GUARD_ZONE = "Europe/Zagreb";
/** Working hours, local: [08:00, 16:00) Monday to Friday. */
export const WORK_START_HOUR = 8;
export const WORK_END_HOUR = 16;

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(zone, f);
  }
  return f;
}

/** The local weekday (`Mon`…`Sun`), hour and minute of `t` in `zone`. */
export function localTime(t: Date, zone = GUARD_ZONE): { weekday: string; hour: number; minute: number } {
  const parts = formatter(zone).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")), minute: Number(get("minute")) };
}

/** Whether `t` is inside working hours (Mon-Fri 08:00-16:00 local). */
export function inWorkingHours(t: Date, zone = GUARD_ZONE): boolean {
  const { weekday, hour } = localTime(t, zone);
  return WEEKDAYS.has(weekday) && hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

/**
 * Why a run of `minutes` starting at `start` may not start, or null when it
 * may: it starts inside working hours, or it would reach them before it ends
 * (checked minute by minute, so a run that ends exactly at 08:00 may start).
 */
export function workingHoursConflict(start: Date, minutes: number, zone = GUARD_ZONE): string | null {
  if (inWorkingHours(start, zone)) {
    const { weekday, hour, minute } = localTime(start, zone);
    return `working hours (${weekday} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${zone}; no solves Mon-Fri 08:00-16:00)`;
  }
  const steps = Math.ceil(Math.max(0, minutes));
  for (let m = 1; m < steps; m += 1) {
    const t = new Date(start.getTime() + m * 60_000);
    if (inWorkingHours(t, zone)) {
      const { weekday } = localTime(t, zone);
      return `the estimated ${Math.round(minutes)} min would run into working hours (${weekday} 08:00 ${zone})`;
    }
  }
  return null;
}

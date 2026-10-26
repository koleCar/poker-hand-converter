/**
 * The user's settings per tournament (R5.5, `tournament_settings`,
 * `20270901090000_tournament_icm.sql`): read and written directly under its
 * owner-only RLS. A `before` trigger checks the shape (`settingsProblem`'s
 * rules) and the limits; an `after` trigger deletes the stored analysis of
 * the tournament's hands, so the next run grades them with the new settings.
 *
 * Keys are `tournamentKey`'s: `site:tournament id`, the site lower-cased as
 * `hands.site` stores it.
 */
import { settingsProblem, type TournamentSettings } from "../analysis/tournament";
import { reportPlanRefusal } from "../entitlements/planRefusal";
import { requireDb } from "./client";

type Row = Record<string, unknown>;

/** At most this many rows are read: the guard's limit per account. */
const MAX_ROWS = 2000;

/** `site:id` as the two columns; null when it is not a key. */
export function splitTournamentKey(key: string): { site: string; tournamentId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  return { site: key.slice(0, at).toLowerCase(), tournamentId: key.slice(at + 1).trim() };
}

/** Only the fields the analysis reads, as the guard accepts them. */
export function cleanSettings(value: unknown): TournamentSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: TournamentSettings = {};
  if (v.kind === "sng" || v.kind === "spin" || v.kind === "mtt") out.kind = v.kind;
  if (Array.isArray(v.payouts)) out.payouts = v.payouts.map(Number);
  if (typeof v.entrants === "number") out.entrants = v.entrants;
  if (typeof v.startingStack === "number") out.startingStack = v.startingStack;
  if (Array.isArray(v.playersLeft)) {
    out.playersLeft = v.playersLeft
      .filter((p): p is Row => !!p && typeof p === "object")
      .map((p) => ({ at: String(p.at ?? ""), left: Number(p.left) }));
  }
  return settingsProblem(out) === null ? out : null;
}

/** Every tournament the user has settings for, by key. */
export async function fetchTournamentSettings(): Promise<Map<string, TournamentSettings>> {
  const { data, error } = await requireDb()
    .from("tournament_settings")
    .select("site, tournament_id, settings")
    .order("updated_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw new Error(error.message);
  const out = new Map<string, TournamentSettings>();
  for (const row of (data ?? []) as Row[]) {
    const settings = cleanSettings(row.settings);
    if (settings && typeof row.site === "string" && typeof row.tournament_id === "string") {
      out.set(`${row.site}:${row.tournament_id}`, settings);
    }
  }
  return out;
}

/** Saves one tournament's settings (the tournament's hands are analysed again). */
export async function saveTournamentSettings(key: string, settings: TournamentSettings): Promise<void> {
  const parts = splitTournamentKey(key);
  if (!parts) throw new Error("Not a tournament.");
  const problem = settingsProblem(settings);
  if (problem) throw new Error(`Tournament settings not saved: ${problem}`);
  const stored = settings as unknown as Record<string, never>;
  // Update, else insert: an upsert would run the guard's insert half (the count, the rate) for an update too.
  const table = () => requireDb().from("tournament_settings");
  const updated = await table().update({ settings: stored }).eq("site", parts.site).eq("tournament_id", parts.tournamentId).select("site");
  // (R6.4) Tournament settings are part of the analysis (Pro): a refusal
  // reaches the upgrade prompt too.
  if (updated.error) {
    reportPlanRefusal(updated.error);
    throw new Error(updated.error.message);
  }
  if ((updated.data ?? []).length > 0) return;
  const { error } = await table().insert({ site: parts.site, tournament_id: parts.tournamentId, settings: stored });
  if (error) {
    reportPlanRefusal(error);
    throw new Error(error.message);
  }
}

/** Forgets one tournament's settings (its hands are analysed again on the assumptions). */
export async function deleteTournamentSettings(key: string): Promise<void> {
  const parts = splitTournamentKey(key);
  if (!parts) return;
  const { error } = await requireDb().from("tournament_settings").delete().eq("site", parts.site).eq("tournament_id", parts.tournamentId);
  if (error) throw new Error(error.message);
}

/**
 * The shared Players screen's `PlayersSource` (`@rail/ui/players/model`,
 * R4.5c) over the web's opponent summaries
 * (`20270714090000_players_screen.sql`): `players_list` (from `player_stats`,
 * R4.5c-1), `player_profile` (the opponent's villain rows of a kind, summed),
 * `player_sites`, and the notes as they are (`set_player_note`), as the
 * reader under RLS. The desktop app implements the same interface over its
 * local store.
 *
 * What the web does not keep it declares: no colour tags and no labels (the
 * owner's decision, 2026-10-23 - they stay the app's, no sync), so the
 * screen leaves them out. A note is the web's `player_notes` row; the tags
 * that row may carry (written in the Reports screen's opponents panel) are
 * kept as they are when the note is saved here.
 *
 * The profile's statistics are made here, as Reports' are: `showStat` of the
 * shipped definitions over the server's sums, with the desktop's rule for
 * an opponent - a definition for the hero only (all-in EV) and money are
 * not theirs to show.
 */
import type { FacetCount } from "@rail/ui/hands/model";
import type { Shown } from "@rail/ui/model/stats";
import type {
  PlayerList,
  PlayerNotes,
  PlayerProfile,
  PlayerRow,
  PlayersSource,
  PlayerSite,
  StakeSample,
  Together,
} from "@rail/ui/players/model";
import { BREAKDOWN_COLUMNS } from "@rail/ui/reports/model";
import { unitForCode } from "../phf";
import { STANDARD_STATS, STATS_VERSION } from "../stats";
import { rpc } from "./client";
import { groupsOf, maybe, num, show, siteName, str, sumsOf, type Row } from "./reportSource";
import { setPlayerNote } from "./stats";

const object = (value: unknown): Row => (value && typeof value === "object" ? (value as Row) : {});

function together(value: unknown): Together {
  const row = object(value);
  return { hands: num(row.hands), moneyHands: num(row.moneyHands), netBbMilli: num(row.netBbMilli) };
}

/** An opponent's statistics: hero-only definitions and money withheld (no value, the sample kept). */
function theirStats(sums: ReturnType<typeof sumsOf>): Shown[] {
  return show(STANDARD_STATS, sums, null).map((shown, index) => {
    const def = STANDARD_STATS[index]?.def;
    return def && (def.players === "hero" || def.format.unit === "money")
      ? { ...shown, value: null, text: null, tone: null }
      : shown;
  });
}

const notOnTheWeb = () => Promise.reject(new Error("Colours and labels are kept in the Rail desktop app."));

/** The web's source; `standardFormat` names hands in Rail's own text format. */
export function webPlayersSource(standardFormat: string): PlayersSource {
  // The tags of each profile read (`site:player`), kept when its note is saved.
  const tags = new Map<string, string[]>();
  const words = (note: string): PlayerNotes => ({ colour: null, note, labels: [] });

  return {
    features: { colours: false, labels: false },

    async list(query): Promise<PlayerList> {
      const raw = await rpc<Row>("players_list", {
        p_query: {
          search: query.search ?? "",
          site: query.site ?? null,
          kind: query.kind ?? "all",
          noted: query.noted ?? null,
          limit: query.limit ?? 200,
          statsVersion: STATS_VERSION,
        },
      });
      const rows = (Array.isArray(raw.rows) ? (raw.rows as Row[]) : []).map((row): PlayerRow => {
        const site = str(row.site) ?? "";
        return {
          site,
          siteName: siteName(site, standardFormat),
          player: typeof row.player === "string" ? row.player : "",
          hands: num(row.hands),
          netBbMilli: maybe(row, "netBbMilli"),
          moneyHands: num(row.moneyHands),
          firstPlayedAt: str(row.firstPlayedAt),
          lastPlayedAt: str(row.lastPlayedAt),
          colour: null,
          labels: [],
          hasNote: row.hasNote === true,
        };
      });
      return {
        rows,
        matching: num(raw.matching),
        players: num(raw.players),
        cashHands: num(raw.cashHands),
        chipsHands: num(raw.chipsHands),
        mixedKind: raw.mixedKind === true,
        hiddenHands: num(raw.hiddenHands),
      };
    },

    async profile(site, player, kind): Promise<PlayerProfile> {
      const raw = await rpc<Row>("player_profile", {
        p_site: site,
        p_player: player,
        p_kind: kind,
        p_stats_version: STATS_VERSION,
      });
      const notes = object(raw.notes);
      tags.set(`${site}:${player}`, Array.isArray(notes.tags) ? (notes.tags as unknown[]).map(String) : []);
      const seen = raw.seen && typeof raw.seen === "object" ? (raw.seen as Row) : null;
      const groups = object(raw.groups);
      const stakes = (Array.isArray(raw.stakes) ? (raw.stakes as Row[]) : []).map((row): StakeSample => {
        const currency = str(row.currency) ?? "";
        return {
          key: str(row.key) ?? "",
          currency,
          currencySymbol: currency ? unitForCode(currency).symbol : "",
          minorUnits: num(row.minorUnits),
          smallBlind: num(row.smallBlind),
          bigBlind: num(row.bigBlind),
        };
      });
      return {
        site,
        siteName: siteName(site, standardFormat),
        player,
        seen: seen
          ? {
              hands: num(seen.hands),
              firstPlayedAt: str(seen.firstPlayedAt),
              lastPlayedAt: str(seen.lastPlayedAt),
              cash: together(seen.cash),
              chips: together(seen.chips),
            }
          : null,
        notes: words(typeof notes.note === "string" ? notes.note : ""),
        mixedKind: raw.mixedKind === true,
        stats: theirStats(sumsOf(object(raw.total))),
        columns: [...BREAKDOWN_COLUMNS],
        byPosition: groupsOf(groups.position, null),
        byStake: groupsOf(groups.stake, null),
        bySize: groupsOf(groups.size, null),
        byFormat: groupsOf(groups.format, null),
        stakes,
        lastPlayedAt: str(raw.lastPlayedAt),
      };
    },

    async sites(): Promise<PlayerSite[]> {
      const raw = await rpc<unknown>("player_sites", { p_stats_version: STATS_VERSION });
      return (Array.isArray(raw) ? raw : [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => ({ value, name: siteName(value, standardFormat) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    labels: (): Promise<FacetCount[]> => Promise.resolve([]),

    async setNote(site, player, note): Promise<PlayerNotes> {
      const saved = await setPlayerNote(site, player, note, tags.get(`${site}:${player}`) ?? []);
      return words(saved?.note ?? "");
    },
    setColour: notOnTheWeb,
    addLabel: notOnTheWeb,
    removeLabel: notOnTheWeb,
  };
}

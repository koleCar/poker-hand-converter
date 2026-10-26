/**
 * Riječi za turnire (R5.5), hrvatski: razlozi, aproksimacije i rečenice
 * igre push/fold te natpisi ICM ploče. Isti oblik kao `analysisIcm.en.ts`.
 */
import type { DecisionAnalysis, IcmFacts, OptionAnalysis } from "../../analysis/types";

const num = (value: number, digits = 0) =>
  value.toLocaleString("hr-HR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number) => `${num(Math.round(value * 100))} %`;
const pct1 = (value: number) => `${num(value * 100, 1)} %`;
const bb = (value: number) => `${num(value, Math.abs(value) < 10 ? 2 : 1)} bb`;

/** Zašto turnirska odluka nije ocijenjena: kraj rečenice "Nije ocijenjeno: …". */
export const tournamentReasonsHr = {
  "tournament-deep":
    "efektivni stack je veći od 20 bb, dublje od igre push/fold - a turnirski žetoni nisu novac, pa cash tablice ovdje ne vrijede",
  "tournament-not-push-fold":
    "na turniru se ocjenjuje samo all-in ili fold (call ili fold protiv all-ina), a ova linija ili akcija nije ni jedno ni drugo",
  "tournament-postflop": "turnirske odluke nakon flopa još se ne ocjenjuju",
  "tournament-posted-all-in": "jedan je igrač bio all-in već od blindova ili antea",
  "tournament-players": "podijeljeno je više od deset igrača",
  "tournament-side-pot":
    "igrač koji može callati ima iza manje od pola all-ina, pa bi njegov call ostavio side pot oko kojeg se bore ostali, a to igra push/fold ne modelira",
} as Record<string, string>;

export const tournamentReasonLabelsHr = {
  tournament: "Turnir: nije analizirano",
  "tournament-deep": "Turnir: dublje od push/folda (više od 20 bb)",
  "tournament-not-push-fold": "Turnir: nije all-in ni fold",
  "tournament-postflop": "Turnir: nakon flopa",
  "tournament-posted-all-in": "Turnir: all-in od blindova",
  "tournament-players": "Turnir: više od deset igrača",
  "tournament-side-pot": "Turnir: side pot kratkog stacka",
} as Record<string, string>;

export const icmApproximationsHr = {
  "push-fold":
    "Igra push/fold: uspoređuju se all-in i fold (call i fold protiv all-ina), ne manji raise ni limp - gubitak folda je dakle najmanji mogući",
  "one-caller": "Callati je moglo više igrača: prvi koji calla igra heads-up, ostali foldaju",
  "icm-chip-ev":
    "Ocijenjeno u žetonima, ne u novcu nagrada: ruka ne kaže koliko je igrača ostalo ni kako se isplaćuje (postavite to za ovaj turnir da bi se ocjenjivalo po ICM-u)",
  "icm-payouts-assumed": "Pretpostavljene standardne isplate za ovu vrstu turnira, ne isplate sobe (možete ih postaviti)",
  "icm-players-left": "Preostali igrači kako ste ih postavili u trenutku prije ove ruke ili u njoj",
  "icm-field-average": "Igrači za drugim stolovima uzeti s prosječnim stackom",
  "icm-monte-carlo": "Udjeli u nagradama uzorkovani (veliko polje), unutar prikazane pogreške",
} as Record<string, string>;

const chipsReasons = {
  "players-left-unknown": "ruka ne kaže koliko je igrača ostalo",
  "payouts-unknown": "nisu poznate ni isplate ni veličina polja",
  "far-field": "ostalo je više od 30 igrača, gdje je udio u nagradama blizu žetonima",
} as Record<string, string>;

const kinds = { sng: "sit-and-goa", spin: "spina", mtt: "turnira s više stolova" } as Record<string, string>;
const gradeWords = { perfect: "Savršeno", good: "Dobro", inaccurate: "Netočno", mistake: "Greška", blunder: "Gruba greška" } as Record<string, string>;

function optionLabel(option: OptionAnalysis): string {
  if (option.allIn) return "all-in";
  return option.action === "call" ? "call" : "fold";
}

/** ICM ocjena u rečenicama (§4). */
export function icmSentencesHr(decision: DecisionAnalysis): string[] {
  const icm = decision.facts.icm;
  if (decision.source !== "icm" || !icm || decision.chosen === null || !decision.grade) return [];
  const word = gradeWords[decision.grade] ?? decision.grade;
  const act = decision.options[1];
  const chosen = decision.options[decision.chosen];
  const verb = icm.scenario === "push" ? "ide all-in" : "calla";
  const hand = decision.facts.handClass ?? "ovom rukom";
  const first =
    decision.grade === "perfect" || decision.grade === "good"
      ? `${word}: odabrali ste ${optionLabel(chosen)}; u ravnoteži igra push/fold s ${hand} ${verb} ${pct(act.freq)} puta.`
      : `${word}: u ravnoteži igra push/fold s ${hand} ${verb} ${pct(act.freq)} puta. ${optionLabel(chosen).replace(/^./, (c) => c.toUpperCase())} košta ${bb(decision.evLoss ?? 0)} (${pct(decision.evLossPot ?? 0)} pota).`;
  return [first, modelSentenceHr(icm)];
}

export function modelSentenceHr(icm: IcmFacts): string {
  if (icm.model === "chips") {
    return `Mjereno u žetonima: ${chipsReasons[icm.chipsReason ?? ""] ?? "nagrade nisu poznate"}.`;
  }
  const payouts = (icm.payouts ?? []).slice(0, 6).map((p) => `${num(p, p % 1 === 0 ? 0 : 1)}`).join(" / ");
  const more = (icm.payouts?.length ?? 0) > 6 ? " …" : "";
  return `Mjereno u udjelu nagrada (ICM): ${icm.playersLeft} preostalih ${kinds[icm.kind] ?? icm.kind}, isplata ${payouts}${more} % (${
    icm.payoutsSource === "user" ? "vaše isplate" : "standardne isplate"
  }); jedan big blind u prosjeku vrijedi ${pct1(icm.bbValue)} nagradnog fonda.`;
}

export const icmHr = {
  heading: "Turnir (push/fold)",
  modelIcm: "Udio u nagradama (ICM)",
  modelChips: "EV u žetonima",
  chipsReasons,
  kinds: { sng: "sit-and-go", spin: "spin", mtt: "turnir s više stolova" } as Record<string, string>,
  kindSources: { phf: "iz ruke", name: "iz imena", assumed: "pretpostavka", user: "postavili ste" } as Record<string, string>,
  sources: { standard: "standardne", user: "vaše", table: "svi za ovim stolom", phf: "iz ruke", "buy-ins": "buy-inovi × sudionici", field: "polje × početni stack" } as Record<
    string,
    string
  >,
  stacks: "Stackovi",
  payouts: "Isplate",
  playersLeft: "Preostali igrači",
  others: (count: number, stack: string) => `još ${num(count)} za drugim stolovima, po ${stack}`,
  prizePool: "Nagradni fond",
  options: "Vaše opcije",
  equity: "Udio u nagradama",
  equityChips: "Udio u žetonima",
  evBb: "EV (bb)",
  start: "Na početku ruke",
  push: "Push",
  call: "Call",
  fold: "Fold",
  pushRange: (who: string, share: number) => `${who} pusha ${pct(share)} ruku`,
  callRange: (who: string, share: number) => `${who} calla ${pct(share)}`,
  you: "Vi",
  bubbleFactor: "Bubble faktor",
  riskPremium: "Premija rizika",
  bfHint: "Koliko gubitak all-ina protiv ovog igrača košta u odnosu na to koliko dobitak donosi: 1 u žetonima",
  rpHint: "Equity iznad 50 % koji treba ravnopravan all-in protiv ovog igrača",
  error: (value: number) => `uzorkovano, pogreška ispod ${pct1(value)} fonda`,
  gap: (value: string) => `Ravnoteža unutar ${value}`,
  player: "Igrač",
  edit: "Isplate i preostali igrači",
  bbs: (value: string) => `${value} bb`,
  bbValue: (value: number) => `1 bb ≈ ${pct1(value)} fonda`,
};

export const icmFormHr = {
  intro:
    "Ono što povijest ruke ne kaže. Prazno polje zadržava pretpostavku. Spremanje vraća ruke ovog turnira u analizu, pa ih sljedeće pokretanje ocjenjuje s vašim postavkama.",
  kind: "Vrsta",
  kindAuto: "Kako ruka kaže",
  payouts: "Isplate, % nagradnog fonda po mjestu",
  payoutsExample: "50, 30, 20",
  entrants: "Sudionici",
  startingStack: "Početni stack (žetoni)",
  playersLeft: "Preostali igrači u ovoj ruci",
  save: "Spremi",
  resetButton: "Natrag na pretpostavke",
  saved: "Spremljeno. Ruke turnira analiziraju se ponovno pri sljedećem pokretanju.",
  reset: "Vaše postavke su obrisane; ruke se ponovno analiziraju na pretpostavkama.",
  problems: {
    kind: "Odaberite vrstu.",
    payouts: "Isplate su postoci, svaki iznad 0 i najviše 100.",
    "payouts-order": "Isplate idu od prvog mjesta naniže: svaka najviše kao prethodna.",
    "payouts-sum": "Isplate zajedno daju najviše 100 %.",
    "payouts-places": "Više plaćenih mjesta nego sudionika.",
    entrants: "Sudionici: cijeli broj, najmanje 2.",
    "starting-stack": "Početni stack: cijeli broj žetona.",
    "players-left": "Preostali igrači: cijeli broj od 2 do broja sudionika.",
  } as Record<string, string>,
};

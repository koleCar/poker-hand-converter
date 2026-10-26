import type { Dict } from "../types";

/** Planovi i prava (Rail R6.2). Same shape as `plan.en.ts`. */
export const planHr: Dict["plan"] = {
  heading: "Plan",
  loading: "Učitavam tvoj plan…",
  unavailable: "Planovi još nisu postavljeni na ovoj bazi. Sve ostalo radi.",
  loadFailed: "Tvoj plan se nije mogao učitati. Osvježi stranicu i pokušaj ponovno.",

  name: { free: "Free", pro: "Pro" },
  badge: "Pro",

  current: (plan: string) => `Tvoj plan: ${plan}`,
  notEnforced:
    "Rail je u ranom pristupu: sve je otvoreno svakom računu i nijedno ograničenje ne vrijedi. Plaćeni planovi još nisu u prodaji.",
  billedMonthly: "Naplata mjesečno",
  billedYearly: "Naplata godišnje",
  status: {
    active: "Aktivan",
    trialing: "Probno razdoblje",
    past_due: "Plaćanje kasni",
    canceled: "Otkazan",
  },
  renews: (date: string) => `Obnavlja se ${date}.`,
  endsOn: (date: string) => `Pro završava ${date}.`,
  graceUntil: (date: string) => `Zadnje plaćanje nije prošlo. Pro ostaje uključen do ${date}.`,
  granted: "Pro, dodijeljen ovom računu.",

  usageHeading: "Tvoja biblioteka",
  usage: (stored: string, cap: string) => `Spremljeno ${stored} od ${cap} ruku`,
  usageUnlimited: (stored: string) => `Spremljeno ${stored} ruku, bez ograničenja`,
  freeHolds: (cap: string) => `Free plan drži do ${cap} ruku.`,
  full: "Biblioteka ti je puna. Prijeđi na Pro da nastaviš spremati ruke.",

  includedHeading: "Što koji plan uključuje",
  freeIncludes: "Free: konverter, replayer, dijeljenje, biblioteka do ograničenja ruku, osnovna statistika.",
  proIncludes:
    "Pro: neograničena biblioteka, desktop HUD i sinkronizacija, potpuni izvještaji, analiza (pregled sesije, propusti, vlastiti chartovi) i Learn.",

  early: (percent: number) =>
    `Pridružio/la si se rano: zadržavaš doživotni popust od ${percent}% na Pro dok god si pretplaćen/a.`,

  upgrade: "Prijeđi na Pro",
  upgradeSoon: "Plaćeni planovi uskoro.",

  lock: {
    heading: "Ovo je Pro značajka",
    body: {
      analysis: "Analiza - pregled sesije, propusti, vlastiti chartovi i vježbe - dio je Pro plana.",
      learn: "Learn je dio Pro plana.",
      reports_full: "Potpuni izvještaji - situacije, sesije, protivnici i igrači - dio su Pro plana.",
      desktop_sync: "Sinkronizacija s desktop aplikacijom dio je Pro plana.",
      hud: "Desktop HUD dio je Pro plana.",
    },
    seePlan: "Pogledaj svoj plan",
  },
};

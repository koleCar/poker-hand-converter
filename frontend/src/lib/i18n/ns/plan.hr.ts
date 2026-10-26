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

  billing: {
    notEnforcedOnSale:
      "Rail je u ranom pristupu: sve je otvoreno svakom računu i nijedno ograničenje ne vrijedi. Na Pro se već možeš pretplatiti.",
    choose: "Razdoblje naplate",
    monthly: "Mjesečno",
    yearly: "Godišnje",
    perMonth: (price: string) => `${price} / mjesec`,
    perYear: (price: string) => `${price} / godina`,
    withDiscount: (price: string, percent: number) => `${price} uz tvoj popust ranog korisnika od ${percent}%`,
    vatIncluded: "Cijene uključuju PDV.",
    vatAdded: "PDV se dodaje pri plaćanju gdje se primjenjuje.",
    vatNote: "Porez se računa prema adresi za naplatu pri plaćanju; tvrtka može upisati svoj PDV broj.",
    earlyAccessNote:
      "Pretplatom sada naplata Pro plana počinje danas. Sve ostaje otvoreno dok je Rail u ranom pristupu.",
    continue: "Nastavi na plaćanje",
    working: "Otvaram stranicu za plaćanje…",
    manage: "Upravljaj pretplatom",
    manageHint: "Promijeni karticu, prebaci se između mjesečne i godišnje naplate, preuzmi račune ili otkaži.",
    opening: "Otvaram…",
    pastDue: "Zadnje plaćanje nije prošlo. Ažuriraj način plaćanja da zadržiš Pro.",
    pastDueUntil: (date: string) =>
      `Zadnje plaćanje nije prošlo. Pro ostaje uključen do ${date}; ažuriraj način plaćanja da ga zadržiš.`,
    canceledUntil: (date: string) =>
      `Pretplata je otkazana. Pro ostaje uključen do ${date}; do tada je možeš obnoviti.`,
    ended: (date: string) => `Pretplata je završila ${date}.`,
    errors: {
      not_signed_in: "Ponovno se prijavi pa pokušaj još jednom.",
      invalid_request: "Nije uspjelo. Osvježi stranicu i pokušaj ponovno.",
      email_unconfirmed: "Najprije potvrdi svoju email adresu: potvrda o plaćanju stiže na nju.",
      account_not_supported: "Ovaj račun se ne može pretplatiti. Prijavi se računom s emailom.",
      rate_limited: "Previše pokušaja u kratkom vremenu. Pričekaj malo pa pokušaj ponovno.",
      unavailable: "Plaćanje trenutno nije dostupno. Pokušaj kasnije.",
      already_subscribed: "Već imaš pretplatu. Promijeni je preko Upravljaj pretplatom.",
      no_customer: "Još nema pretplate kojom bi se upravljalo.",
      failed: "Nešto je pošlo po zlu. Ništa nije naplaćeno. Pokušaj ponovno.",
    },
    success: {
      metaTitle: "Plaćanje primljeno | Rail",
      heading: "Hvala",
      body: "Plaćanje je prošlo. Pro se uključuje čim ga Stripe potvrdi, obično za nekoliko sekundi.",
      waiting: "Čekam potvrdu…",
      active: "Pro je uključen za tvoj račun.",
      slow: "Potvrda traje duže nego inače. Plan će se sam ažurirati; ovu stranicu možeš napustiti.",
      back: "Natrag na tvoj plan",
    },
    cancel: {
      metaTitle: "Plaćanje otkazano | Rail",
      heading: "Plaćanje otkazano",
      body: "Ništa nije naplaćeno. Pretplatiti se možeš kad god želiš.",
      back: "Natrag na tvoj plan",
    },
  },

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

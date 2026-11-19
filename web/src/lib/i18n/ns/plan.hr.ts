import type { Dict } from "../types";

/** Planovi i prava (Rail R6.2). Same shape as `plan.en.ts`. */
export const planHr: Dict["plan"] = {
  heading: "Plan",
  earlyAccess: "Rani pristup",
  open: "Otvori",
  loading: "Učitavam tvoj plan…",
  unavailable: "Planovi još nisu postavljeni na ovoj bazi. Sve ostalo radi.",
  loadFailed: "Tvoj plan se nije mogao učitati. Osvježi stranicu i pokušaj ponovno.",

  name: { free: "Free", pro: "Pro" },
  badge: "Pro",

  current: (plan: string) => `Tvoj plan: ${plan}`,
  notEnforced: "Sve je otvoreno dok je Rail u ranom pristupu.",
  billed: { month: "Naplata mjesečno", half_year: "Naplata svakih 6 mjeseci", year: "Naplata godišnje" },
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

  usageHeading: "Biblioteka",
  usage: (stored: string, cap: string) => `${stored} / ${cap} ruku`,
  usageUnlimited: (stored: string) => `${stored} ruku`,
  full: "Biblioteka ti je puna",

  todayHeading: "Danas",
  handsToday: (saved: string, cap: string) => `${saved} / ${cap} ruku`,
  flopsToday: (opened: string, cap: string) => `${opened} / ${cap} flopova`,
  resets: (time: string) => `Ponovno od ${time}`,

  pricing: "Planovi i cijene",
  upgrade: "Prijeđi na Pro",

  billing: {
    // PRAVNI TEKST - NACRT: prije pokretanja treba pregled vlasnika i pravnika
    // (vidi komentar u `plan.en.ts`). Svaka izmjena je nova verzija teksta.
    consent: {
      legend: "Prije plaćanja",
      termsBefore: "Prihvaćam ",
      termsLink: "Uvjete korištenja",
      immediate:
        "Tražim da Rail Pro počne odmah i potvrđujem da time gubim pravo na jednostrani raskid ugovora nakon što počne.",
      required: "Za nastavak na plaćanje označi oba polja.",
    },
    working: "Otvaram stranicu za plaćanje…",
    manage: "Upravljaj pretplatom",
    manageHint: "Promijeni karticu ili razdoblje naplate, preuzmi račune ili otkaži.",
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
      consent_required: "Prije nastavka na plaćanje označi oba polja.",
      consent_outdated: "Tekst na ovoj stranici je promijenjen. Osvježi stranicu, ponovno ga pročitaj i označi oba polja.",
    },
    success: {
      metaTitle: "Plaćanje primljeno | Rail",
      heading: "Hvala",
      body: "Plaćanje je prošlo. Pro se uključuje čim ga Stripe potvrdi, obično za nekoliko sekundi.",
      // PRAVNI TEKST - nacrt za pregled vlasnika i pravnika.
      confirmation:
        "Na tvoj zahtjev Pro počinje odmah. Prihvaćanje Uvjeta korištenja i potvrda da gubiš pravo na jednostrani raskid ugovora nakon što Pro počne zabilježeni su uz tvoj račun - nalaze se u preuzimanju tvojih podataka (Postavke, Tvoji podaci) - a ponavlja ih i potvrda o plaćanju koju ti Stripe šalje emailom.",
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
      solver_unlimited: "Svaki flop, svaki dan, dio je Pro plana.",
      nodelock: "Nodelock je dio Pro plana.",
    },
    seePlan: "Pogledaj svoj plan",
  },
};

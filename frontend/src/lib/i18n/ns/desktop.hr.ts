import type { Dict } from "../types";

/** `/auth/desktop`, Croatian. Same shape as `desktop.en.ts`. */
export const desktopHr: Dict["desktop"] = {
  metaTitle: "Prijava u aplikaciju Rail | Rail",
  metaDescription: "Prijavi aplikaciju Rail na ovom računalu svojim računom.",
  heading: "Prijava u aplikaciju Rail",
  checking: "Provjeravam prijavu…",
  notConfigured: "Računi na ovoj instalaciji nisu dostupni, pa se aplikacija ovdje ne može prijaviti.",

  signedOut: {
    body: "Aplikacija Rail na ovom računalu traži prijavu. Prvo se prijavi ovdje, zatim potvrdi.",
    reason: "Prijavi se, zatim potvrdi prijavu u aplikaciju Rail.",
    cta: "Prijavi se",
  },

  confirm: {
    account: (email: string) => `Prijavljen si kao ${email}.`,
    question: "Prijaviti aplikaciju Rail na ovom računalu ovim računom?",
    detail:
      "Aplikacija dobiva vlastitu prijavu; ovaj preglednik ostaje prijavljen. Nastavi samo ako si upravo odabrao Prijava u aplikaciji Rail.",
    approve: "Prijavi Rail",
    working: "Prijavljujem…",
    otherAccount: "Koristi drugi račun",
    cancel: "Odustani",
  },

  done: {
    heading: "Otvaram Rail…",
    body: "Preglednik će možda pitati smije li otvoriti Rail. Dopusti, i aplikacija će dovršiti prijavu.",
    openAgain: "Otvori Rail",
    close: "Ovu karticu možeš zatvoriti.",
  },

  cancelled: {
    heading: "Odustao si",
    body: "Aplikacija Rail nije prijavljena. Ovu karticu možeš zatvoriti.",
  },

  errors: {
    invalid: "Ovaj link za prijavu nije potpun. Kreni ispočetka iz aplikacije Rail: Postavke, Račun, Prijava.",
    expired: "Ovaj link za prijavu je istekao (vrijedi deset minuta). Kreni ispočetka iz aplikacije Rail.",
    used: "Ova prijava je već poslana aplikaciji Rail. Ako se aplikacija nije otvorila, kreni ispočetka iz nje.",
    unconfirmed: "Prvo potvrdi e-mail adresu: link je u tvom sandučiću. Zatim kreni ispočetka iz aplikacije.",
    unsupported: "Ovim računom se ne može prijaviti u aplikaciju Rail.",
    rateLimited: "Previše prijava za ovaj račun u zadnjih sat vremena. Pokušaj kasnije.",
    notSignedIn: "Tvoja prijava ovdje je istekla. Prijavi se ponovno, zatim potvrdi.",
    failed: "Aplikaciju Rail trenutno nije moguće prijaviti. Pokušaj za minutu.",
    unavailable: "Prijava u aplikaciju Rail na ovoj instalaciji još nije dostupna.",
  },
};

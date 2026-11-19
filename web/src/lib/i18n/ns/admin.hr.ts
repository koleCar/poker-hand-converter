import type { Dict } from "../types";

const n = (value: number) => value.toLocaleString("hr-HR");
const plural = (count: number, one: string, few: string, many: string) => {
  const ten = count % 10;
  const hundred = count % 100;
  if (ten === 1 && hundred !== 11) return one;
  if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return few;
  return many;
};

/** `/admin`, Croatian. Same shape as `admin.en.ts`. */
export const adminHr: Dict["admin"] = {
  metaTitle: "Admin | Rail",
  menu: "Admin",
  nav: { label: "Admin odjeljci", users: "Korisnici", reports: "Prijave" },
  denied: "Samo za admine.",
  signIn: "Prijavi se admin računom da otvoriš ovu stranicu.",
  loading: "Učitavam…",
  error: (reason: string) => `Učitavanje nije uspjelo: ${reason}`,
  retry: "Pokušaj ponovno",

  users: {
    search: "Traži email, korisničko ime ili id",
    count: (total: number) => `${n(total)} ${plural(total, "račun", "računa", "računa")}`,
    empty: "Nijedan račun ne odgovara.",
    columns: {
      user: "Korisnik",
      plan: "Plan",
      hands: "Ruke",
      lastHand: "Zadnje ruke",
      posts: "Objave",
      feedback: "Prijave",
      created: "Pridružen",
      signedIn: "Zadnja prijava",
    },
    sortBy: (column: string) => `Poredaj po: ${column}`,
    banned: "Blokiran",
    unconfirmed: "Nepotvrđen",
    never: "Nikad",
  },

  page: {
    previous: "Prethodna",
    next: "Sljedeća",
    range: (from: number, to: number, total: number) => `${n(from)}–${n(to)} od ${n(total)}`,
  },

  user: {
    back: "Korisnici",
    notFound: "Taj račun ne postoji.",
    copyId: "Kopiraj id",
    copied: "Kopirano",
    stats: {
      hands: "Ruke",
      played: "Igrano",
      posts: "Objave",
      comments: "Komentari",
      publishedHands: "Objavljene ruke",
      shares: "Linkovi za dijeljenje",
      trainerAnswers: "Odgovori u treneru",
      feedback: "Prijave",
    },
    account: "Račun",
    fields: {
      id: "Id",
      email: "Email",
      emailConfirmed: "Email potvrđen",
      created: "Pridružen",
      signedIn: "Zadnja prijava",
      providers: "Načini prijave",
      role: "Uloga",
      karma: "Karma",
      digest: "Sažetak",
      banned: "Blokiran do",
      banReason: "Razlog blokade",
      shadowbanned: "Shadowban",
    },
    plan: "Plan",
    planFields: {
      plan: "Plan",
      status: "Status",
      period: "Razdoblje naplate",
      periodEnd: "Tekuće razdoblje završava",
      stripe: "Stripe kupac",
    },
    yes: "Da",
    no: "Ne",
    none: "—",
    bySite: "Ruke po sobi",
    byOrigin: "Ruke po izvoru",
    origins: { web: "Web", desktop: "Desktop aplikacija", upload: "Učitavanje" } as Record<string, string>,
    sources: "Mape i uređaji",
    sourceColumns: { name: "Mapa", device: "Uređaj", room: "Soba", inserted: "Spremljeno", rejected: "Odbijeno", last: "Zadnji uvoz" },
    noSources: "Još nema mape ni izvora.",
    arrivals: "Zadnji dolasci",
    arrivalHands: (count: number) => `${n(count)} ${plural(count, "ruka", "ruke", "ruku")}`,
    noArrivals: "Još nije stigla nijedna ruka.",
    feedback: "Prijave",
    noFeedback: "Ovaj račun nema prijava.",
    allFeedback: "Otvori u Prijavama",
  },

  reports: {
    status: { all: "Sve", new: "Nove", read: "Pročitane", done: "Riješene", spam: "Spam" } as Record<string, string>,
    kind: { all: "Sve vrste", bug: "Greška", feature: "Prijedlog", question: "Pitanje" } as Record<string, string>,
    statusLabel: "Status",
    kindLabel: "Vrsta",
    forUser: (who: string) => `Od: ${who}`,
    clearUser: "Prikaži sve",
    empty: "Ovdje nema prijava.",
    visitor: "Posjetitelj",
    columns: { report: "Prijava", from: "Od", where: "Gdje", when: "Kada", status: "Status" },
    images: (count: number) => `${count} ${plural(count, "slika", "slike", "slika")}`,
    sources: { web: "Web", app: "Aplikacija" } as Record<string, string>,
    detail: {
      replyTo: "Odgovor na",
      account: "Račun",
      page: "Stranica",
      version: "Verzija aplikacije",
      platform: "Platforma",
      locale: "Jezik",
      openImage: (index: number) => `Otvori snimku ${index} u punoj veličini`,
      imagesLoading: "Učitavam snimke…",
      imagesError: "Snimke se nisu mogle učitati.",
      mark: "Označi kao",
    },
    setError: "Status nije spremljen.",
  },
};

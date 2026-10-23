import { plural } from "../plural";
import type { Dict } from "../types";

const liveNum = (value: number) => value.toLocaleString("hr-HR");
/** "1 spremljena ruka", "2 spremljene ruke", "5 spremljenih ruku". */
const liveSaved = (count: number) =>
  `${liveNum(count)} ${plural(count, "spremljena ruka", "spremljene ruke", "spremljenih ruku")}`;

/** Strings for the app's chrome, Croatian. Same shape as `chrome.en.ts`. */
export const chromeHr: Dict["chrome"] = {
  intl: "hr-HR",
  close: "Zatvori",
  closeNamed: (what: string) => `Zatvori: ${what.toLowerCase()}`,
  auth: {
    titles: { "sign-in": "Prijava", "sign-up": "Napravi račun", reset: "Nova lozinka" },
    submit: { "sign-in": "Prijavi se", "sign-up": "Napravi račun", reset: "Pošalji link" },
    lead: "Tvoje ruke ostaju privatne, vezane uz tvoj račun.",
    google: "Nastavi s Googleom",
    googleFailed: "Prijava Googleom nije uspjela.",
    or: "ili",
    email: "E-mail",
    password: "Lozinka",
    working: "Radim…",
    robotFirst: "Prvo dovrši provjeru da nisi robot.",
    failed: "Nije uspjelo. Pokušaj ponovno.",
    confirmSent: (email: string) => `Na ${email} stiže link za potvrdu, a zatim se prijavi.`,
    resetSent: (email: string) => `Ako ${email} ima račun, link za novu lozinku je na putu.`,
    toSignUp: "Napravi račun",
    toReset: "Zaboravljena lozinka?",
    toSignIn: "← Natrag na prijavu",
    guest: "Nastavi bez računa",
    guestNote: "Pretvaranje radi. Za spremanje i dijeljenje treba račun.",
    turnstileFailed: "Provjera da nisi robot nije se učitala. Osvježi stranicu i pokušaj ponovno.",
  },
  menu: {
    signIn: "Prijava",
    signOut: "Odjava",
    signingOut: "Odjavljujem…",
  },
  share: {
    button: "Podijeli ruku",
    creating: "Stvaram link…",
    failed: "Link za dijeljenje nije stvoren.",
    signIn: "Prijavi se za link za dijeljenje. Svatko kome ga pošalješ može ga otvoriti bez računa.",
    heading: "Podijeli ovu ruku",
    hint: "Svatko s ovim linkom može pogledati ruku — bez računa.",
    linkLabel: "Link za dijeljenje",
    copy: "Kopiraj",
    open: "Otvori link",
    via: "Podijeli putem…",
    webShareTitle: "Replay pokerske ruke",
    copied: "Link je kopiran.",
    copyBlocked: "Preglednik je blokirao kopiranje. Označi link iznad i kopiraj ga ručno.",
    names: {
      label: "Prikaži imena igrača",
      explain:
        "Isključeno: svi s ovim linkom vide Hero, Villain1, Villain2… bez stola, broja ruke i vremena igre. Uključeno: nadimci kako ih je soba ispisala.",
      hidden: "Imena su na ovom linku skrivena",
      shown: "Imena su na ovom linku prikazana",
      saving: "Spremam…",
      failed: (reason: string) => `Promjena nije spremljena: ${reason}`,
    },
  },
  db: {
    offlineTitle: "Baza podataka nije postavljena. Konverter radi bez nje; spremljene ruke i dijeljenje nisu dostupni.",
    offline: "Offline — bez baze",
    offlineShort: "Offline",
    connected: "Baza povezana",
    stored: (count: string, n: number) => `${count} ${plural(n, "spremljena ruka", "spremljene ruke", "spremljenih ruku")}`,
  },
  live: {
    region: "Aktivnost uživo",
    elsewhere: "U drugoj kartici ili na drugom uređaju",
    uploadSaving: (sent: number, total: number | null, estimated: boolean) =>
      total
        ? `Spremam ${liveNum(sent)} od ${estimated ? "~" : ""}${liveNum(total)} ${plural(total, "ruke", "ruke", "ruku")} s web učitavanja`
        : `Spremam ${liveNum(sent)} ${plural(sent, "ruku", "ruke", "ruku")} s web učitavanja`,
    uploadRetrying: (sent: number) =>
      `Web učitavanje: problem s vezom, pokušavam ponovno (dosad ${liveSaved(sent)})`,
    uploadWaiting: (sent: number) =>
      `Web učitavanje čeka budžet učitavanja računa (dosad ${liveSaved(sent)})`,
    uploadPaused: (sent: number) =>
      `Web učitavanje pauzirano na ${liveNum(sent)} ${plural(sent, "ruci", "ruke", "ruku")} — nastavi ga u kartici u kojoj je pokrenuto`,
    uploadDone: (inserted: number, duplicates: number) =>
      `Web učitavanje gotovo: ${liveNum(inserted)} ${plural(inserted, "nova ruka spremljena", "nove ruke spremljene", "novih ruku spremljeno")}${
        duplicates ? `, ${liveNum(duplicates)} ${plural(duplicates, "već postoji", "već postoje", "već postoji")} u biblioteci` : ""
      }`,
    desktopSyncing: (hands: number) =>
      `Desktop aplikacija sinkronizira: dosad ${liveNum(hands)} ${plural(hands, "ruka", "ruke", "ruku")}`,
    newHands: (count: number) =>
      count > 0
        ? `${plural(count, "Stigla je", "Stigle su", "Stiglo je")} ${liveNum(count)} ${plural(count, "nova ruka", "nove ruke", "novih ruku")} — osvježi`
        : "Stigle su nove ruke — osvježi",
    announceUpload: "U drugoj kartici traje web učitavanje.",
    announceDesktop: "Desktop aplikacija sinkronizira ruke.",
  },
};

/**
 * The Players screen's words, Croatian. Same shape as `players.en.ts`; moved
 * from the desktop app's dictionary (`app/src/i18n/hr.ts` `players`, R4.5c).
 */

import { plural } from "./plural";
import type { playersUiEn } from "./players.en";

const num = (value: number) => value.toLocaleString("hr-HR");
/** Nominativ: 1 ruka, 2 ruke, 5 ruku. */
const ruku = (count: number) => `${num(count)} ${plural(count, "ruka", "ruke", "ruku")}`;
/** Akuzativ (kroz, za): 1 ruku, 2 ruke, 5 ruku. */
const rukuAcc = (count: number) => `${num(count)} ${plural(count, "ruku", "ruke", "ruku")}`;
/** The sentence's first letter in capitals. */
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const playersUiHr: typeof playersUiEn = {
  storeError: (reason) => `Igrači se nisu učitali: ${reason}`,
  loading: "Učitavam igrače…",
  noMatch: "Nijedan protivnik ne odgovara.",
  count: (players) => `${num(players)} ${plural(players, "protivnik", "protivnika", "protivnika")}`,
  countOf: (matching, total) => `${num(matching)} od ${num(total)} protivnika`,
  search: "Traži igrače",
  searchPlaceholder: "Ime počinje s…",
  kinds: {
    label: "Igra",
    all: "Sve igre",
    cash: "Cash",
    chips: "Turniri",
  },
  room: "Soba",
  anyRoom: "Sve sobe",
  colourFilter: "Boja",
  labelFilter: "Oznaka",
  noted: "S bilješkom",
  clearFilters: "Očisti filtre",
  defaultKind: (kind) =>
    `Prikazujem samo: ${kind}. Turnirski žetoni i novac ne zbrajaju se u jedan rezultat. Promijeni gumbima Igra.`,
  mixedKind:
    "Ove ruke miješaju turnirske žetone i novac, pa tvoj rezultat protiv pojedinog protivnika nije prikazan. Odaberi Cash ili Turniri.",
  hidden: (count) =>
    `${cap(ruku(count))} protivnika iz soba koje skrivaju korisnička imena (poput GGPokera) ${plural(count, "ulazi", "ulaze", "ulazi")} u tvoju statistiku, ali ${plural(count, "nije", "nisu", "nije")} na popisu: ime ondje traje jednu sesiju, pa ga se ne može pratiti iz sesije u sesiju.`,
  listLabel: "Protivnici, najviše zajedničkih ruku prvo",
  columns: {
    name: "Igrač",
    room: "Soba",
    hands: "Zajedničke ruke",
    result: "Tvoj rezultat (bb)",
    lastSeen: "Zadnji put",
  },
  showMore: "Prikaži još",
  colours: {
    red: "Crvena",
    orange: "Narančasta",
    yellow: "Žuta",
    green: "Zelena",
    blue: "Plava",
    purple: "Ljubičasta",
  },
  noColour: "Bez boje",
  colourOf: (colour) => `Oznaka bojom: ${colour}`,
  hasNote: "Ima bilješku",
  profile: {
    label: "Profil igrača",
    close: "Zatvori profil",
    loading: "Učitavam profil…",
    failed: (reason) => `Profil se nije učitao: ${reason}`,
    notOpponent:
      "Ovo ime nije protivnik iz sobe koja prikazuje korisnička imena, pa nema profil i ne prima bilješke.",
    together: "Zajedničke ruke",
    togetherCash: (count) => `${num(count)} u cash igrama`,
    togetherChips: (count) => `${num(count)} na turnirima`,
    firstSeen: "Prvi put",
    lastSeen: "Zadnji put",
    result: "Tvoj rezultat protiv tog igrača",
    resultCash: "Cash",
    resultChips: "Turniri",
    resultLine: (bb, count) => `${bb} bb kroz ${rukuAcc(count)}`,
    perHundred: (value) => `${value} bb/100`,
    noHands: "Nema ruku",
    handsWith: (count) => `Ruke s ovim igračem (${num(count)})`,
    kind: "Igra",
    kindHint: "Brojevi tog igrača u cash igrama, na turnirima ili u oboje; dok ovdje ne odabereš, vrijedi odabir s popisa.",
    stats: "Statistika igrača",
    sample: (count) => `Kroz ${rukuAcc(count)} tog igrača, s tobom ili bez tebe.`,
    statsNote:
      "Ovo su igračevi brojevi iz svake njegove ruke koju je Rail vidio. All-in EV računa se samo za tvoje ruke i ovdje nije prikazan. Vrijednost blijedi dok joj je uzorak malen; zadrži pokazivač na njoj za uzorak i 95 % interval.",
    mixedKind:
      "Ruke tog igrača miješaju turnirske žetone i novac, pa su brojevi u big blindovima izostavljeni. Odaberi Cash ili Turniri.",
    breakdown: "Raščlamba",
    tabs: {
      position: "Pozicija",
      stake: "Ulozi",
      size: "Veličina stola",
      format: "Igra",
    },
    heads: {
      position: "Pozicija",
      stake: "Ulozi",
      size: "Stol",
      format: "Igra",
    },
    noPosition: "Bez pozicije",
    empty: "Nema ruku u ovoj raščlambi.",
    colour: "Oznaka bojom",
    labels: "Oznake",
    addLabel: "Dodaj oznaku",
    labelPlaceholder: "Oznaka, pa Enter",
    removeLabel: (label) => `Ukloni oznaku „${label}”`,
    labelsHint: "Do osam oznaka od najviše 24 znaka.",
    note: "Bilješka",
    notePlaceholder: "Kako igra, zapažanja, podsjetnici…",
    noteSaved: "Spremljeno",
    noteSaving: "Spremam…",
    saveFailed: (reason) => `Nije spremljeno: ${reason}`,
  },
};

import { plural } from "../hr";
import type { Dict } from "../types";

/** Strings for the stats components, Croatian. Same shape as `stats.en.ts`. */

const num = (value: number) => value.toLocaleString("hr-HR");
/** Nominativ: 1 ruka, 2 ruke, 5 ruku. */
const hands = (count: number) => `${num(count)} ${plural(count, "ruka", "ruke", "ruku")}`;
/** Genitiv, iza "od" / "kroz": od 1 ruke, od 2 ruke, od 5 ruku. */
const handsGen = (count: number) => `${num(count)} ${plural(count, "ruke", "ruke", "ruku")}`;
/** Akuzativ, iza "kroz": kroz 1 ruku, kroz 2 ruke, kroz 5 ruku. */
const handsAcc = (count: number) => `${num(count)} ${plural(count, "ruku", "ruke", "ruku")}`;

export const statsHr: Dict["stats"] = {
  common: {
    hands,
    handsHead: "Ruke",
    result: "Rezultat",
    bb100: "bb/100",
    bb: (amount: string) => `${amount} bb`,
    winRate: "Winrate",
    tryAgain: "Pokušaj ponovno",
    unknownStakes: "Nepoznat limit",
  },

  columns: {
    vpip: { head: "VPIP", title: "Dobrovoljno uložen novac u pot" },
    pfr: { head: "PFR", title: "Raise preflop" },
    rfi: { head: "RFI", title: "Prvi raise u neotvoreni pot" },
    threeBet: { head: "3-bet", title: "3-bet protiv jednog raisea" },
    foldToThreeBet: { head: "F3B", title: "Fold na 3-bet nakon otvaranja" },
    steal: { head: "Steal", title: "Pokušaj steala s CO, BTN ili SB" },
    cbet: { head: "Cbet", title: "Continuation bet na flopu" },
    foldToCbet: { head: "FvCb", title: "Fold na continuation bet na flopu" },
    af: { head: "AF", title: "Postflop (betovi + raiseovi) / callovi" },
    wtsd: { head: "WTSD", title: "Došao/la do showdowna nakon viđenog flopa" },
    wsd: { head: "W$SD", title: "Dobiven novac na showdownu" },
  },

  tab: {
    heading: "Statistika",
    sample: (count: number, version: string) => `${hands(count)} · ${version}`,
    signInHeading: "Prijavi se da vidiš svoju statistiku",
    signInBody:
      "Statistika se računa iz ruku u tvojoj biblioteci, pa joj treba račun kojem pripada. Za pretvaranje, pregled i preuzimanje račun nikad ne treba.",
    signIn: "Prijavi se",
    notInstalledHeading: "Statistika još nije postavljena na ovoj bazi",
    notInstalledBody: {
      beforeTable: "Tvoje ruke su na sigurnom — ovaj ekran čita zasebnu tablicu, ",
      beforeFile: ", koja stiže s vlastitom migracijom. Primijeni ",
      afterFile:
        " i ponovno učitaj stranicu. Ništa drugo na Railu nije pogođeno: učitavanje, pregledavanje, replay i dijeljenje rade i bez nje.",
    },
    loading: "Čitam tvoje ruke…",
    emptyHeading: "Još nema ruku sa statistikom",
    emptyBody:
      "Statistika se računa iz ruku u tvojoj biblioteci, na serveru, čim se spreme. Učitaj hand history i ovaj ekran će se popuniti.",
    winRateNote:
      "Kumulativni big blindovi, grupirani po broju ruku, a ne po datumu — pauza između sesija ne zaslužuje ni djelić x-osi.",
  },

  coverage: {
    running: (done: number, target: number) =>
      target > 0 ? `Ažuriram statistiku… ${num(done)} od ${handsGen(target)}` : `Ažuriram statistiku… ${hands(done)}`,
    failedRebuild: (message: string) => `Statistiku nije bilo moguće ažurirati: ${message}`,
    behind: (behind: number, total: number) =>
      `Ove brojke još ne uključuju ${num(behind)} od ${handsGen(total)}.`,
    unreadable: (count: number) =>
      `${handsAcc(count)} nije bilo moguće pročitati — to je bug u konverteru, ne u tvojoj datoteci.`,
    rebuild: "Ponovno izračunaj statistiku",
  },

  scope: {
    ariaLabel: "Koje ruke",
    allFormats: "Svi formati",
    formats: {
      cash: "Cash igre",
      tournament: "Turniri",
      "sit-and-go": "Sit & Go",
      spin: "Spinovi",
    },
    stakes: "Limit",
    allStakes: "Svi limiti",
    stakeOption: (stake: string, count: number) => `${stake} · ${hands(count)}`,
  },

  tile: {
    confidence: {
      firm: "Velik uzorak — ovaj broj je stabilan.",
      loose: "Srednji uzorak — oblik je stvaran, decimala nije.",
      noise: "Mali uzorak — čitaj ovo kao naznaku, ne kao mjerenje.",
    },
    noOpportunities: "nema prilika",
    interval: (low: string, high: string) => `95% interval pouzdanosti, od ${low}% do ${high}%`,
    noSample: "nema uzorka",
  },

  hud: {
    mixedUnitKind:
      "Ovaj uzorak miješa turnirske čipove i cash. Čipovi nisu novac — vrijede onoliko koliko kaže struktura isplata — pa nema zbroja koji bi se mogao prikazati. Filtriraj na jedan format igre.",
    noMoney: "Za ovaj uzorak nema iznosa u novcu.",
    provisional: (count: number, floor: number) =>
      `${hands(count)}. Winrate se ne smiri prije otprilike ${handsGen(floor)}, pa ovo čitaj kao smjer, a ne kao broj.`,
    currency: "Valuta",
    inMoney: "U novcu",
    mixed: "miješano",
    mixedCurrency:
      "Ovaj uzorak obuhvaća više valuta, pa je zbroj u novcu izostavljen — dolari zbrojeni s eurima daju broj bez jedinice. Brojke u big blindovima iznad nisu pogođene: big blind je jedinica igre, a ne valute, i upravo se u njemu sprema.",
    preflop: "Preflop",
    postflop: "Postflop",
    showdown: "Showdown",
    postflopNote: {
      before: "Lanac continuation betova prati PokerTrackerovo pravilo: cbet na turnu računa se samo ako je cbet na flopu bio ",
      emphasis: "callan",
      after: ", jer ta definicija odgovara na pitanje „barrelam li”.",
    },
    aggressionFactor: "Faktor agresije",
    aggressionFrequency: "Učestalost agresije",
    tiles: {
      vpip: { label: "VPIP", hint: "Dobrovoljno uložen novac" },
      pfr: { label: "PFR", hint: "Raise preflop" },
      rfi: { label: "RFI", hint: "Prvi raise u neotvoreni pot" },
      threeBet: { label: "3-bet", hint: "Protiv jednog raisea" },
      foldToThreeBet: { label: "Fold na 3-bet", hint: "Nakon otvaranja" },
      fourBet: { label: "4-bet", hint: "Protiv dva raisea" },
      squeeze: { label: "Squeeze", hint: "Raise preko raisea i callera" },
      coldCall: { label: "Cold call", hint: "Call na raise bez uloženog novca" },
      steal: { label: "Steal", hint: "CO / BTN / SB, svi su foldali do tebe" },
      foldToSteal: { label: "Fold na steal", hint: "Na blindu, protiv steala" },
      cbetFlop: { label: "Cbet flop", hint: "Kao preflop raiser" },
      cbetTurn: { label: "Cbet turn", hint: "Nakon što je cbet na flopu callan" },
      cbetRiver: { label: "Cbet river", hint: "Treći barrel" },
      foldToCbet: { label: "Fold na cbet", hint: "Na flopu" },
      raiseCbet: { label: "Raise na cbet", hint: "Na flopu" },
      donkBet: { label: "Donk bet", hint: "U prethodnog agresora" },
      checkRaise: { label: "Check-raise", hint: "Na flopu" },
      sawFlop: { label: "Vidio/la flop", hint: "Od svih podijeljenih ruku" },
      wwsf: { label: "WWSF", hint: "Dobiveno nakon viđenog flopa" },
      wtsd: { label: "WTSD", hint: "Došao/la do showdowna nakon viđenog flopa" },
      wsd: { label: "W$SD", hint: "Dobiveno na showdownu" },
    },
  },

  breakdown: {
    heading: "Raščlamba",
    splitBy: "Podijeli po",
    groups: {
      position: { label: "Pozicija", head: "Pozicija" },
      table_size: { label: "Broj igrača", head: "Igrači" },
      stack_bb: { label: "Dubina stacka", head: "Stack (bb)" },
      stakes: { label: "Limit", head: "Limit" },
      site: { label: "Soba", head: "Soba" },
    },
    bb100Title: "Big blindovi dobiveni na 100 ruku",
    unknown: "Nepoznato",
    headsUp: "Heads-up",
    handed: (players: string) => `${players} za stolom`,
    moneyTitle: (net: string, count: number) => `${net} bb kroz ${handsAcc(count)}`,
    opportunities: (count: number) => `${num(count)} ${plural(count, "prilika", "prilike", "prilika")}`,
    note: (thin: number) =>
      `Sivi brojevi počivaju na manje od ${thin} prilika, a točkasti winrate na manje od 100 ruku — to je smjer, a ne očitanje.`,
  },

  matrix: {
    heading: "Početne ruke",
    colourBy: "Boja prema",
    metrics: {
      bb100: "Winrate",
      vpip: "VPIP",
      pfr: "PFR",
      hands: "Podijeljeno",
    },
    position: "Pozicija",
    everySeat: "Sve pozicije",
    gridLabel: "Početne ruke, trinaest puta trinaest",
    cellLabel: (handClass: string, count: number | null) =>
      `${handClass}: ${count === null ? "nikad podijeljena" : hands(count)}`,
    detailMoney: (net: string, bb100: string) => `${net} bb (${bb100} bb/100)`,
    neverDealt: "nikad podijeljena u ovom uzorku",
    hint: {
      bb100: "Winrate po ruci, u bb po odigranoj ruci. Blijede ćelije su mali uzorci, a ne mali rezultati.",
      hands: "Koliko je često svaka ruka podijeljena, po kombinaciji — ujednačena mreža znači pošten špil.",
      played: "Koliko si često igrao/la svaku ruku. Odaberi ćeliju za brojke.",
    },
  },

  sessions: {
    heading: "Sesije",
    breakLongerThan: "Pauza dulja od",
    gap: (minutes: number) =>
      minutes < 60
        ? `${minutes} ${plural(minutes, "minute", "minute", "minuta")}`
        : `${minutes / 60} ${plural(minutes / 60, "sata", "sata", "sati")}`,
    bankrollCaption: (sessions: number) =>
      `Bankroll kroz ${num(sessions)} ${plural(sessions, "sesiju", "sesije", "sesija")}:`,
    bankrollAria: (amount: string, sessions: number) =>
      `Bankroll, ${amount} kroz ${sessions} ${plural(sessions, "sesiju", "sesije", "sesija")}`,
    session: "Sesija",
    length: "Trajanje",
    tables: "Stolovi",
    duration: (minutes: number) =>
      minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`,
    showLatest: "Prikaži samo najnovije",
    showAll: (sessions: number) => `Prikaži sve sesije (${num(sessions)})`,
  },

  opponents: {
    heading: "Protivnici",
    offBody:
      "HUD za svakog regulara protiv kojeg si igrao/la i koliko dobivaš ili gubiš protiv svakog od njih. Sprema po jedan redak za svakog protivnika u svakoj ruci — otprilike šest puta više prostora nego tvoja vlastita statistika — pa je isključen dok ga ne uključiš. Ako ga kasnije isključiš, ti se redci brišu; tvoje ruke i tvoje brojke u svakom slučaju ostaju netaknute.",
    turnOn: "Uključi statistiku protivnika",
    storageRefused: "Ovaj preglednik nije htio spremiti postavku (privatni način?).",
    reading: "Čitam protivnike iz tvojih ruku…",
    removing: "Uklanjam statistiku protivnika…",
    findPlayer: "Pronađi igrača",
    screenName: "Nadimak",
    atLeast: "Najmanje",
    anySample: "bilo koji uzorak",
    player: "Igrač",
    youVsThem: { head: "Ti protiv njih", title: "Tvoj rezultat u rukama u kojima su i oni dobili karte" },
    addNote: "Dodaj privatnu bilješku",
    noteButton: "+ bilješka",
    overHands: (count: number) => `kroz ${handsAcc(count)}`,
    nobodyByThatName: "U ovom uzorku nema nikoga s tim imenom.",
    noOpponents: "U ovom uzorku još nema protivnika.",
    opaque: (count: number) =>
      `Protivničke ruke iz soba koje skrivaju imena između sesija (GGPoker) nisu prikazane, njih ${num(count)} — isti nadimak u dvije sesije mogu biti dvije različite osobe.`,
    positional: "Sobe koje sjedala označavaju pozicijom (Ignition) nikad ne bilježe protivnike.",
    turnOff: "Isključi i obriši statistiku protivnika",
    note: {
      label: "Bilješka (vidiš je samo ti)",
      tags: "Oznake, odvojene zarezom",
      tagsPlaceholder: "nit, station, reg",
      save: "Spremi",
      delete: "Obriši bilješku",
      cancel: "Odustani",
    },
  },

  graph: {
    series: {
      total: { label: "Ukupno", hint: "Sve dobiveno i izgubljeno" },
      showdown: { label: "Showdown", hint: "Ruke koje su došle do showdowna" },
      nonShowdown: { label: "Bez showdowna", hint: "Ruke završene prije showdowna" },
      allInEv: {
        label: "All-in EV",
        hint: (runouts: number) => `Ukupno, s all-in runoutima (${num(runouts)}) isplaćenima po equityju`,
      },
    },
    mixedUnitKind:
      "Ovaj uzorak miješa turnirske čipove i cash, pa nema grafa winratea koji bi se mogao nacrtati. Čipovi nisu novac — vrijede onoliko koliko kaže struktura isplata — a krivulja koja ih zbraja s dolarima bila bi oblik bez značenja. Filtriraj na jedan format igre.",
    notEnough:
      "Još nema dovoljno ruku za krivulju. Graf treba barem nekoliko skupina odigranih ruku; nastavi učitavati.",
    ariaLabel: (count: number) =>
      `Kumulativni winrate kroz ${handsAcc(count)}, podijeljen na ukupne big blindove te one dobivene sa showdownom i bez njega.`,
    axisLabel: "Odigrane ruke",
    noDates: "ove ruke nemaju datume",
    noAllIns: "još nema all-ina",
    notComputed: "još nije izračunato",
    noAllInsHint: "Pojavljuje se čim neka ruka u ovom uzorku ima all-in prije posljednje karte",
    notComputedHint: "Treba equity kroz runout",
    mixedCurrency:
      "Ovaj uzorak obuhvaća više valuta, pa je serija u novcu izostavljena i crtaju se samo one u big blindovima. Dolari zbrojeni s eurima daju krivulju bez jedinice; big blindovi su jedinica igre i zbrajaju se ispravno.",
    showNumbers: "Prikaži brojke",
    from: "Od",
    to: "Do",
  },
};

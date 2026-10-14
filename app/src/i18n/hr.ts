/**
 * Croatian (R2.8: chosen in Settings, Appearance). The web's register: the
 * reader is "ti", and sentences avoid the past tense of the second person,
 * which would need the reader's gender ("Prijava: ..." rather than
 * "Prijavljen si ..."). A count picks its noun's form with the shared
 * `plural` (one / few / many: 1 ruka, 2 ruke, 5 ruku) and is grouped the
 * Croatian way (`countIn`: 1.204). Poker's own words (pot, stack, showdown,
 * all-in, board) stay as Croatian players say them, as on the web.
 */
import { plural } from "@rail/ui/strings/plural";

import { countIn } from "./format";
import type { Dict } from "./types";

/** Counts in Croatian digits ("1.204"), whatever the window's language. */
const n = countIn("hr");

/** After a number: 1 ruka, 2 ruke, 5 ruku. */
function ruku(count: number): string {
  return `${n(count)} ${plural(count, "ruka", "ruke", "ruku")}`;
}

/** After "od", "iz": od 1 ruke, od 2 ruke, od 5 ruku. */
function odRuku(count: number): string {
  return `${n(count)} ${plural(count, "ruke", "ruke", "ruku")}`;
}

/** As an object (kroz, za, odbio je): 1 ruku, 2 ruke, 5 ruku. */
function rukuAcc(count: number): string {
  return `${n(count)} ${plural(count, "ruku", "ruke", "ruku")}`;
}

function mapa(count: number): string {
  return `${n(count)} ${plural(count, "mapu", "mape", "mapa")}`;
}

function datoteka(count: number): string {
  return `${n(count)} ${plural(count, "datoteka", "datoteke", "datoteka")}`;
}

/** The sentence's first letter in capitals. */
function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const hr: Dict = {
  brand: {
    name: "Rail",
  },

  nav: {
    label: "Glavni izbornik",
    today: "Danas",
    hands: "Ruke",
    reports: "Izvještaji",
    players: "Igrači",
    hud: "HUD",
    settings: "Postavke",
    search: "Traži…",
    searchLabel: "Traži ili pokreni naredbu",
  },

  placeholder: "Još nije napravljeno.",

  screens: {
    today: {
      title: "Danas",
      lead: "Tvoja trenutna sesija: rezultat, odigrane ruke i stanje uvoza.",
    },
    hands: {
      title: "Ruke",
      lead: "Sve ruke, s filterima, replayerom, oznakama i bilješkama.",
    },
    reports: {
      title: "Izvještaji",
      lead: "Zarada i all-in EV kroz vrijeme, rezultati po poziciji i situaciji.",
    },
    players: {
      title: "Igrači",
      lead: "Profili protivnika, bilješke i oznake bojom.",
    },
    hud: {
      title: "HUD",
      lead: "Uređivač HUD-a i njegovi preseti.",
    },
    settings: {
      title: "Postavke",
      lead: "Mape, sobe, račun i izgled.",
    },
  },

  today: {
    heading: "Tvoje ruke",
    loading: "Učitavanje…",
    unavailable: "Spremište ruku dostupno je samo unutar aplikacije Rail.",
    storeError: (reason) => `Spremište ruku nije otvoreno: ${reason}`,
    empty: "Još nema ruku. Rail ih uvozi iz mapa s poviješću ruku čim ih postaviš.",
    hands: "Spremljene ruke",
    handsToday: "Uvezeno danas",
    files: "Pročitane datoteke",
    filesWithErrors: "Datoteke s greškom",
    folders: "Praćene mape",
    quarantined: "Odbijene ruke",
    unsupported: "Nepodržani formati",
    outbox: "Čeka sinkronizaciju",
    storeFile: "Spremljeno u",
    account: "Postavke računa",
    session: {
      current: "Trenutna sesija",
      last: "Zadnja sesija",
      heading: "Sesija",
      loading: "Čitam tvoju sesiju…",
      none: "Još nema sesije. Tvoja sesija pojavit će se ovdje s prvom rukom koju Rail uveze.",
      error: (reason) => `Sesija se nije učitala: ${reason}`,
      started: (time) => `Počela u ${time}`,
      range: (from, to) => `${from} – ${to}`,
      lasted: (duration) => `${duration} dosad`,
      duration: (minutes) =>
        minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`,
      rule: (minutes) =>
        `Sesija je niz ruku bez stanke dulje od ${minutes} ${plural(minutes, "minute", "minute", "minuta")}, preko svih stolova.`,
      result: "Rezultat",
      resultBb: "U big blindovima",
      hands: "Ruke",
      perHour: "Ruku na sat",
      tables: "Stolovi",
      perHourTitle: "Kroz dosadašnje trajanje sesije",
      mixedKind: "Ova sesija miješa turnirske žetone i cash, pa nema rezultata koji bi se mogao zbrojiti.",
      mixedCurrency: "Ova sesija obuhvaća više valuta: rezultat je samo u big blindovima.",
      stats: "Statistika sesije",
      statsNote: "Bomb potovi nisu u statistici, kao ni drugdje; rezultat ih uključuje.",
      pots: "Najveći potovi",
      potsNote: "U big blindovima. Otvori ruku u Rukama.",
      potColumns: {
        time: "Vrijeme",
        stakes: "Ulozi",
        cards: "Karte",
        pot: "Pot",
        result: "Rezultat",
      },
      potBb: (bb) => `${bb} bb`,
      openHand: (id) => `Otvori ruku #${id} u Rukama`,
      reports: "Svi izvještaji",
    },
  },

  watch: {
    heading: "Uvoz",
    loading: "Učitavanje…",
    unavailable: "Stanje uvoza dostupno je samo unutar aplikacije Rail.",
    notRunning: (reason) => `Uvoz nije pokrenut: ${reason}`,
    running: "Rail čita nove ruke iz ovih mapa čim ih soba zapiše.",
    paused: "Uvoz je pauziran. Promjene se bilježe i čitaju kad ga nastaviš.",
    pause: "Pauziraj uvoz",
    resume: "Nastavi uvoz",
    noFolders: "Još se ne prati nijedna mapa.",
    findFolders: "Pronađi mape s rukama…",
    folder: "Mapa",
    status: "Stanje",
    handsToday: "Danas",
    hands: "Ruke",
    lastImport: "Zadnji uvoz",
    issues: "Problemi",
    never: "Nikad",
    none: "Nema",
    states: {
      watching: "Prati se",
      polling: "Provjerava se (mrežna mapa)",
      unavailable: "Nije dostupna",
      error: "Ne može se čitati",
      disabled: "Isključena",
    },
    quarantined: (count) => `${n(count)} ${plural(count, "odbijena", "odbijene", "odbijenih")}`,
    fileErrors: (count) => `${n(count)} ${plural(count, "nečitljiva", "nečitljive", "nečitljivih")}`,
    pending: (count) => `${n(count)} ${plural(count, "čeka", "čekaju", "čeka")} kraj ruke`,
  },

  foundFolders: {
    room: "Soba",
    folder: "Mapa",
    files: "Datoteke",
    lastHand: "Zadnja ruka",
    watch: (path) => `Prati ${path}`,
    atLeast: (count) => `${count}+`,
    noFiles: "Još nema",
    unknown: "Nepoznato",
    watched: "Već se prati",
    manual: "Dodana ručno",
    unverified: "Ova zadana mapa još nije potvrđena na stvarnoj instalaciji.",
    notThisRoom: "Najnovije datoteke ovdje ne izgledaju kao ruke ove sobe.",
  },

  importChoice: {
    importAll: "Uvezi sve",
    importAllHint: "Sve ruke koje su već tu, a zatim svaku novu dok igraš.",
    onlyNew: "Samo nove ruke",
    onlyNewHint: "Ono što je sada tu ostaje; uvoze se samo ruke odigrane od sada.",
  },

  firstRun: {
    title: "Dobrodošlica u Rail",
    lead: "Tri koraka do prvog HUD-a: prijava, potvrda mapa s rukama, otvaranje stola.",
    unavailable: "Postavljanje je dostupno samo unutar aplikacije Rail.",
    skip: "Preskoči zasad",

    signIn: {
      heading: "1. Prijava",
      useOffline: "Koristi bez računa",
      offlineChosen: "Rail radi bez računa. Prijaviti se možeš bilo kada u Postavkama, Račun.",
    },

    folders: {
      heading: "2. Potvrdi mape s rukama",
      searching: "Tražim mape tvojih poker soba…",
      found: (count) => `Rail je na ovom računalu pronašao ${mapa(count)}.`,
      lead: "Odznači mapu koju ne želiš. Kasnije to možeš promijeniti u Postavkama.",
      empty: "Rail na ovom računalu nije pronašao nijednu mapu s rukama.",
      lookedFor: (rooms) => `Tražio je u zadanim mapama ovih soba: ${rooms}.`,
      noRooms: "Za ovaj sustav još nije poznata zadana mapa nijedne poker sobe.",
      verifying:
        "Zadane mape svake sobe provjeravamo na stvarnim instalacijama, pa ovaj popis raste s novim verzijama. Ako tvoja soba sprema ruke negdje drugdje, dodaj mapu sam.",
      addManually: "Ručno dodaj mapu…",
      choosing: "Odabir…",
      existingHeading: "Ruke koje su već u ovim mapama",
      confirm: (count) => `Prati ${mapa(count)}`,
      adding: "Dodavanje…",
      added: (count) => `Rail prati ${mapa(count)}.`,
      discoverFailed: (reason) => `Traženje mapa nije uspjelo: ${reason}`,
      addFailed: (reason) => `Mape nisu dodane: ${reason}`,
    },

    table: {
      heading: "3. Otvori stol",
      body: "Igraj kao i inače. Rail čita svaku ruku čim je soba zapiše, a ekran Danas pokazuje kako stižu.",
      done: "Idi na Danas",
    },
  },

  account: {
    heading: "Račun",
    loading: "Učitavanje…",
    notConfigured: "Ova verzija Raila nema uslugu računa. Sve radi na ovom računalu; ništa se ne sinkronizira.",
    signedOut:
      "Prijavi se da ti ruke budu usklađene s webom. Rail otvara stranicu za prijavu u pregledniku, gdje upravitelj lozinki i prijava Googleom rade kao inače.",
    signIn: "Prijavi se u pregledniku",
    waiting: (time: string) => `Dovrši prijavu u pregledniku (još ${time}).`,
    waitingHint: "Već si prijavljen na webu? Potvrdi ondje gumbom Prijavi Rail.",
    openAgain: "Ponovno otvori stranicu",
    cancel: "Odustani",
    signedInAs: (email: string) => `Prijava: ${email}`,
    online: "Povezano.",
    offline: "Izvan mreže. Rail radi dalje i sam se ponovno povezuje.",
    signOut: "Odjava",
    notSignedIn: "Nema prijave: ruke ostaju na ovom računalu.",
    signingInShort: "Prijava u pregledniku…",
    signingOut: "Odjavljivanje…",
    failed: (reason: string) => `Nije uspjelo: ${reason}`,
    notices: {
      cancelled: "Prijava je otkazana u pregledniku.",
      timedOut: "Prijava je trajala dulje od deset minuta. Pokušaj ponovno.",
      notInProgress: "Taj link za prijavu bio je za raniji pokušaj ili je Rail u međuvremenu ponovno pokrenut. Pokušaj ponovno.",
      invalidLink: "Taj link za prijavu nije valjan. Pokušaj ponovno.",
      linkRejected: "Ta prijava je istekla ili je već iskorištena. Pokušaj ponovno.",
      offline: "Rail nije mogao doći do poslužitelja da dovrši prijavu. Provjeri vezu i pokušaj ponovno.",
      sessionEnded:
        "Odjava: sesija je završena na poslužitelju (npr. nakon promjene lozinke). Prijavi se ponovno.",
      keychainUnavailable:
        "Rail ne može koristiti sistemski spremnik ključeva, pa će nakon ponovnog pokretanja tražiti prijavu.",
      signedOutLocally: "Odjava na ovom računalu je izvršena. Rail nije mogao doći do poslužitelja da ondje završi sesiju.",
      browserFailed: "Rail nije mogao otvoriti preglednik. Upotrijebi Ponovno otvori stranicu.",
    },
  },

  sync: {
    heading: "Sinkronizacija",
    loading: "Učitavanje…",
    off: "Ova verzija Raila nema sinkronizaciju. Ruke ostaju na ovom računalu.",
    starting: "Pokretanje…",
    signedOut: (waiting) =>
      waiting === 0
        ? "Prijavi se za sinkronizaciju. Do tada ruke ostaju na ovom računalu."
        : `Prijavi se za sinkronizaciju. Do tada na ovom računalu ${plural(waiting, "čeka", "čekaju", "čeka")} ${ruku(waiting)}.`,
    paused: (waiting) =>
      waiting === 0
        ? "Sinkronizacija je pauzirana."
        : `Sinkronizacija je pauzirana. Slanje ${plural(waiting, "čeka", "čekaju", "čeka")} ${ruku(waiting)}.`,
    mismatch: (owner, email, count) =>
      `${cap(ruku(count))} s ovog računala ${plural(count, "sinkronizirana je", "sinkronizirane su", "sinkronizirano je")} na ${owner}. Sada je prijavljen račun ${email}.`,
    mismatchQuestion: (email) => `Prenijeti ih i na ${email}?`,
    mismatchHint:
      "Prijenos ih kopira u knjižnicu ovog računa; ništa se nigdje ne briše. Dok ne odabereš, ništa se ne šalje ni ne preuzima.",
    upload: (email) => `Prenesi na ${email}`,
    keepApart: "Drži ih odvojeno",
    declined: (email) =>
      `Bez sinkronizacije: ruke s ovog računala ostaju odvojene od ${email}. Prijavi se drugim računom za nastavak.`,
    uploadInstead: (email) => `Ipak ih prenesi na ${email}`,
    anotherAccount: "drugi račun",
    syncing: (sent, total) => `Sinkronizacija: ${n(sent)} od ${odRuku(total)}.`,
    speed: (perSecond, kb) => `Oko ${ruku(perSecond)} u sekundi (${n(kb)} KB/s).`,
    capped: (limit) => `Slanje je ograničeno na ${limit} dok se sinkronizira velik zaostatak.`,
    upToDate: "Sve je sinkronizirano.",
    lastSync: (time) => `Zadnja sinkronizacija: ${time}.`,
    offline: (waiting) =>
      waiting === 0
        ? "Izvan mreže. Rail sam nastavlja kad se veza vrati."
        : `Izvan mreže. ${cap(ruku(waiting))} ${plural(waiting, "čeka", "čekaju", "čeka")}; Rail ${plural(waiting, "je", "ih", "ih")} sam šalje kad se veza vrati.`,
    rateLimited: (time) => `Ograničenje sinkronizacije računa trenutno je dosegnuto. Rail nastavlja u ${time}.`,
    failed: (reason, time) => `Problem sa sinkronizacijom: ${reason}. Rail pokušava ponovno u ${time}.`,
    retrying: (count) => `${cap(ruku(count))} ${plural(count, "šalje", "šalju", "šalje")} se uskoro ponovno.`,
    pulled: (count) =>
      `S weba i s tvojih drugih računala ${plural(count, "dodana je", "dodane su", "dodano je")} ${ruku(count)}.`,
    pullSkipped: (count) =>
      `${cap(ruku(count))} s weba ${plural(count, "treba", "trebaju", "treba")} noviju verziju Raila.`,
    rejectedHeading: (count) => `Poslužitelj je odbio ${rukuAcc(count)}`,
    rejectedHint: "Ponovno slanje ne pomaže. Nakon nadogradnje Raila pokušaj ponovno.",
    reasons: {
      shape: "Nedostaju dijelovi ruke",
      schema: "Nepoznata verzija formata",
      "hand-key": "ID ruke se ne podudara",
      "raw-text": "Sadržavala je izvorni tekst",
      "too-large": "Prevelika",
      invalid: "Vrijednost koju poslužitelj ne prihvaća",
      unreadable: "Ovdje se ne može pročitati",
    },
    otherReason: (code) => `Ostalo (${code})`,
    tryAgain: "Pokušaj ponovno",
    syncNow: "Sinkroniziraj sada",
    pause: "Pauziraj sinkronizaciju",
    resume: "Nastavi sinkronizaciju",
    capLabel: "Brzina slanja dok se sinkronizira velik zaostatak",
    caps: {
      slow: "256 KB/s",
      normal: "1 MB/s (zadano)",
      fast: "4 MB/s",
      none: "Bez ograničenja",
    },
    today: {
      upToDate: "Sinkronizirano s webom.",
      syncing: (sent, total) => `Sinkronizacija s webom: ${n(sent)} od ${odRuku(total)}.`,
      waiting: (count) => `${cap(ruku(count))} ${plural(count, "čeka", "čekaju", "čeka")} sinkronizaciju.`,
      offline: "Izvan mreže: ruke se sinkroniziraju kad se veza vrati.",
      paused: "Sinkronizacija je pauzirana.",
      question: "Sinkronizacija čeka tvoj odgovor.",
      problem: "Sinkronizacija ima problem.",
      details: "Postavke sinkronizacije",
    },
    failedAction: (reason) => `Nije uspjelo: ${reason}`,
  },

  settings: {
    loading: "Učitavanje…",
    saveFailed: (reason) => `Promjena nije spremljena: ${reason}`,
    unavailable: "Postavke su dostupne samo unutar aplikacije Rail.",

    folders: {
      heading: "Mape s rukama",
      body: "Rail čita nove ruke iz ovih mapa čim ih tvoje poker sobe zapišu.",
      loading: "Učitavanje mapa…",
      notRunning: (reason) => `Uvoz nije pokrenut: ${reason}`,
      loadFailed: (reason) => `Mape se nisu učitale: ${reason}`,
      empty: "Još se ne prati nijedna mapa. Dodaj je ili pusti Rail da potraži mape tvojih poker soba.",
      add: "Dodaj mapu…",
      choosing: "Odabir…",
      findAgain: "Ponovno potraži mape",
      setup: "Otvori ekran za postavljanje",
      list: "Praćene mape",

      search: {
        heading: "Mape koje je Rail pronašao",
        searching: "Tražim mape tvojih poker soba…",
        failed: (reason) => `Traženje mapa nije uspjelo: ${reason}`,
        noneNew: "Nema novih mapa: svaka mapa koju Rail poznaje već se prati.",
        found: (count) =>
          `Rail je pronašao ${n(count)} ${plural(count, "mapu koja se još ne prati", "mape koje se još ne prate", "mapa koje se još ne prate")}.`,
        existingHeading: "Ruke koje su već u ovim mapama",
        confirm: (count) => `Prati ${mapa(count)}`,
        adding: "Dodavanje…",
        added: (count) => `Rail sada prati još ${mapa(count)}.`,
        close: "Zatvori",
      },

      room: "Soba",
      roomFound: (name) => `${name} (pronašao Rail)`,
      roomChosen: (name) => `${name} (tvoj odabir)`,
      roomDetected: "Prepoznaje se po datoteci",
      roomAuto: "Prepoznaj po datoteci",
      roomHint:
        "Sobu odaberi samo ako Rail ne prepoznaje ruke iz ove mape: tada se svaka datoteka u njoj čita kao ruke te sobe.",
      lastImport: "Zadnji uvoz",
      never: "Nikad",
      handsToday: "Ruke danas",
      hands: "Ruke",
      files: "Datoteke",
      problems: "Problemi",
      noProblems: "Nema",
      fileErrors: (count) =>
        `${n(count)} ${plural(count, "datoteka se ne može čitati", "datoteke se ne mogu čitati", "datoteka se ne može čitati")}`,
      pending: (count) =>
        `${n(count)} ${plural(count, "datoteka čeka", "datoteke čekaju", "datoteka čeka")} kraj svoje ruke`,
      quarantined: (count) => `${n(count)} ${plural(count, "odbijena ruka", "odbijene ruke", "odbijenih ruku")}`,

      showRefused: (count) => (count === 1 ? "Prikaži odbijenu ruku" : `Prikaži odbijene ruke (${n(count)})`),
      hideRefused: "Sakrij odbijene ruke",
      refusedHeading: (path) => `Odbijene ruke u ${path}`,
      refusedLoading: "Učitavanje odbijenih ruku…",
      refusedFailed: (reason) => `Odbijene ruke se nisu učitale: ${reason}`,
      refusedEmpty: "Nema odbijenih ruku.",
      refusedLead:
        "Rail nije mogao pročitati ove ruke. Čuvaju se, kako bi ih kasnija verzija mogla pročitati; razlog kaže zašto.",
      byReason: "Po razlogu",
      refusedMore: (shown, total) => `Prikazano je najnovijih ${n(shown)} od ${n(total)}.`,

      settingsOf: (path) => `Postavke za ${path}`,
      enabled: "Prati ovu mapu",
      enabledHint: "Isključena mapa se ne čita. Njezine ruke ostaju u Railu.",
      recursive: "Uključi podmape",
      pollOnly: "Provjeravaj promjene periodično",
      pollOnlyHint: "Za mrežne mape, čije obavijesti o promjenama možda ne stižu: Rail gleda svakih nekoliko sekundi.",
      changePath: "Promijeni mapu…",
      remove: "Ukloni…",
      saved: "Spremljeno.",
      roomSaved: (count) =>
        count === 0
          ? "Spremljeno."
          : `Spremljeno. ${n(count)} ${plural(count, "datoteka se ponovno čita", "datoteke se ponovno čitaju", "datoteka se ponovno čita")} kao ruke te sobe.`,
      actionFailed: (reason) => `Mapa nije promijenjena: ${reason}`,

      folder: "Mapa",
      cancel: "Odustani",
      addHeading: "Dodaj mapu",
      addHint: "Može bilo koja mapa: na ovom računalu, vanjskom disku ili mrežnom dijeljenju.",
      addConfirm: "Prati ovu mapu",
      adding: "Dodavanje…",
      addedOne: (path) => `Rail prati ${path}.`,
      addFailed: (reason) => `Mapa nije dodana: ${reason}`,
      existingHeading: "Ruke koje su već u ovoj mapi",

      moveHeading: "Promijeni ovu mapu",
      moveFrom: "Sada",
      moveTo: "Nova mapa",
      moveBody:
        "Ako su u novoj mapi iste datoteke (mapa je premještena ili kopirana), Rail nastavlja gdje je stao. Inače čita novu mapu, a ruke već uvezene iz stare ostaju u Railu.",
      moveConfirm: "Koristi novu mapu",
      moving: "Mijenjanje…",
      moved: (moved, detached) =>
        moved === 0
          ? "Gotovo. Rail čita novu mapu; ruke iz stare mape ostaju u Railu."
          : detached === 0
            ? `Gotovo. ${n(moved)} ${plural(moved, "datoteka nastavlja", "datoteke nastavljaju", "datoteka nastavlja")} gdje je Rail stao.`
            : `Gotovo. ${n(moved)} ${plural(moved, "datoteka nastavlja", "datoteke nastavljaju", "datoteka nastavlja")} gdje je Rail stao; ${datoteka(detached)} ondje ${plural(detached, "nije pronađena", "nisu pronađene", "nije pronađeno")}, a ${plural(detached, "njezine", "njihove", "njihove")} ruke ostaju u Railu.`,

      removeHeading: "Ukloniti ovu mapu?",
      removeBody: (hands) =>
        hands === 0
          ? "Rail je prestaje pratiti. Ništa se u mapi ne briše."
          : `Rail je prestaje pratiti. ${cap(ruku(hands))} ${plural(hands, "uvezena", "uvezene", "uvezenih")} iz nje ${plural(hands, "ostaje", "ostaju", "ostaje")} u Railu, a ništa se u mapi ne briše.`,
      removeConfirm: "Ukloni mapu",
      removing: "Uklanjanje…",
      removed: (path) => `Rail više ne prati ${path}. Njezine ruke ostaju.`,
    },

    appearance: {
      heading: "Izgled",
      theme: "Tema",
      system: "Prema sustavu",
      dark: "Tamna",
      light: "Svijetla",
      density: "Gustoća",
      densityHint: "Koliko su gusto složeni popisi i tablice: visina retka, razmaci i veličina slova.",
      comfortable: "Prozračno",
      compact: "Zbijeno",
      language: "Jezik",
      languageHint: "Prozor i izbornik u traci sustava. Brojevi i datumi ga prate.",
      languages: {
        en: "English",
        hr: "Hrvatski",
      },
    },

    startup: {
      heading: "Pokretanje",
      startAtLogin: "Pokreni Rail pri prijavi u sustav",
      startAtLoginHint: "Rail se pokreće u traci sustava, spreman za uvoz, bez otvaranja ovog prozora.",
    },

    about: {
      heading: "O aplikaciji",
      version: "Verzija",
      core: "Jezgra",
      handFormat: "Format ruku",
      parsers: (count) => `${n(count)} ${plural(count, "parser", "parsera", "parsera")}`,
      sites: "Sobe u sites.json",
      sitesCount: (count, version) => `${n(count)} (verzija formata ${version})`,
      configError: (reason) => `sites.json se nije učitao: ${reason}`,
      logs: "Zapisi (logovi)",
      settingsFile: "Datoteka postavki",
      unknown: "Nepoznato",
    },
  },

  dev: {
    heading: "Za razvoj: pretvori jednu datoteku",
    note: "Samo u debug buildu. Pokreće Rust jezgru na datoteci i pokazuje rezultat.",
    pick: "Odaberi datoteku…",
    running: "Pretvaranje…",
    file: "Datoteka",
    encoding: "Kodiranje",
    detected: "Prepoznato",
    detectedAs: (parser, permille) => `${parser} (${permille} ‰)`,
    nothing: "Ništa",
    hands: "Ruke",
    refused: "Odbijeno",
    byParser: "Po parseru",
    firstRefusals: "Prva odbijanja",
    unrecognized: "Nijedan parser ne prepoznaje datoteku (išla bi u registar nepodržanih formata).",
    problem: (kind) => `Nije čitljivo kao tekst: ${kind}`,
    error: (message) => `Jezgra je bacila iznimku: ${message}`,
    millis: (ms) => `${ms} ms`,
    time: "Vrijeme",
  },

  devStats: {
    heading: "Za razvoj: statistike",
    note: "Samo u debug buildu. Pozadinski posao koji ponovno gradi statistike i računa all-in EV preflop all-inova.",
    activity: "Radi",
    activities: {
      idle: "Ništa",
      rebuilding: "Ponovno gradi statistike",
      indexing: "Razvrstava protivnike novih ruku",
      computing: "Računa all-in EV",
      "paused-backfill": "Čeka da uvoz završi",
      "paused-tables": "All-in EV čeka dok su stolovi otvoreni",
      stopped: "Zaustavljen",
    },
    rebuild: "Ponovna izgradnja",
    rebuildProgress: (done, total) => `${n(done)} od ${odRuku(total)}`,
    none: "Nema",
    evPending: "Ruke koje čekaju all-in EV",
    evComputed: "Izračunan all-in EV",
    evTime: (count, ms) => `${ruku(count)} u ${(ms / 1000).toFixed(1).replace(".", ",")} s`,
    rebuildButton: "Ponovno izgradi statistike",
    evButton: "Ponovno izračunaj all-in EV",
    rebuildStarted: (count) => `Statistika se ponovno gradi za ${rukuAcc(count)}.`,
    evQueued: (count) => `${cap(ruku(count))} ${plural(count, "čeka", "čekaju", "čeka")} all-in EV.`,
  },

  backfill: {
    of: (path) => `Uvoz ruku iz mape ${path}`,
    title: (percent) => `Uvoz starih ruku: ${percent} %`,
    estimating: "Procjenjuje se preostalo vrijeme…",
    left: (seconds) =>
      seconds < 60
        ? "Još manje od minute"
        : seconds < 5400
          ? `Još oko ${Math.round(seconds / 60)} min`
          : `Još oko ${Math.round(seconds / 3600)} h`,
    detail: (mbDone, mbTotal, filesDone, filesTotal, hands) =>
      `${mbDone} od ${mbTotal} MB · datoteke: ${filesDone} od ${filesTotal} · ruke dosad: ${hands}`,
  },

  refused: {
    heading: "Odbijene ruke",
    lead: "Ruke koje Rail nije mogao pročitati, iz svih mapa. Čuvaju se s tekstom, pa ih novija verzija može pročitati.",
    loading: "Učitavanje odbijenih ruku…",
    loadFailed: (reason) => `Odbijene ruke nisu učitane: ${reason}`,
    none: "Nema odbijenih ruku.",
    total: (count) => `${plural(count, "Odbijena je", "Odbijene su", "Odbijeno je")} ${ruku(count)}.`,
    byReason: "Po razlogu",
    pickReason: "Odaberi razlog da vidiš njegove ruke.",
    ofReason: (reason) => `Ruke odbijene kao ${reason}`,
    more: (shown, total) => `Prikazano je ${n(shown)} najnovijih od ${n(total)}.`,
    reason: "Razlog",
    details: "Pojedinosti",
    file: "Datoteka",
    seen: "Zadnji put",
    text: "Tekst",
    showText: "Prikaži tekst",
    showTextOf: (file) => `Prikaži tekst odbijene ruke iz datoteke ${file}`,
    textHeading: "Odbijena ruka",
    textLabel: "Ruka kako ju je soba zapisala",
    textLoading: "Učitavanje teksta…",
    textFailed: (reason) => `Tekst nije učitan: ${reason}`,
    gone: "Ova ruka više nije odbijena: ponovno je pročitana.",
    parser: "Parser",
    parserVersion: (parser, version) => `${parser}, verzija ${version}`,
    noParser: "Nijedan parser je nije prepoznao",
    copy: "Kopiraj tekst",
    copied: "Kopirano.",
    copyFailed: "Kopiranje nije uspjelo. Označi tekst i kopiraj ga sam.",
    close: "Zatvori",
    retry: "Pokušaj ponovno nakon nadogradnje",
    retrying: "Ponovno čitanje…",
    retryHint: (hands, files) =>
      `Starija verzija parsera odbila je ${rukuAcc(hands)} (${datoteka(files)}). Ova ${plural(hands, "je", "ih", "ih")} verzija možda može pročitati.`,
    upToDate: "Ove su ruke odbili parseri ove verzije.",
    retried: (files) =>
      files === 0
        ? "Nema ničeg za ponovno čitanje."
        : `Ponovno se ${plural(files, "čita", "čitaju", "čita")} ${datoteka(files)}.`,
    retryFailed: (reason) => `Ponovno čitanje nije uspjelo: ${reason}`,
  },

  hands: {
    unavailable: "Tvoje ruke dostupne su samo u aplikaciji Rail.",
    storeError: (reason) => `Popis ruku nije se učitao: ${reason}`,
    loading: "Učitavam ruke…",
    empty: "Još nema ruku. Pojavit će se ovdje čim ih Rail uveze iz tvojih mapa s poviješću ruku.",
    noMatch: "Nijedna ruka ne odgovara ovim filterima.",
    rebuilding: (done, total) =>
      `Popis ruku osvježava se nakon nadogradnje: ${n(done)} od ${odRuku(total)}. Popis se puni usput.`,
    count: (shown) => ruku(shown),
    countOf: (matching, total) => `${n(matching)} od ${odRuku(total)}`,
    loadingMore: "Učitavam još…",
    listLabel: "Ruke, najnovije prve",
    columns: {
      date: "Datum",
      room: "Soba",
      stakes: "Ulozi",
      position: "Poz.",
      cards: "Karte",
      board: "Board",
      result: "Rezultat",
      bigBlinds: "bb",
      marks: "Oznake",
    },
    noCards: "—",
    preflop: "Bez flopa",
    noHero: "—",
    handId: (id) => `#${id}`,
    rowLabel: (date, room, stakes, result) => `${date}, ${room}, ${stakes}, ${result}`,
    allIn: "All-in",
    allInEv: (ev) => `All-in · EV ${ev} bb`,
    evShort: (ev) => `EV ${ev}`,
    allInPending: "All-in · EV se računa",
    showdown: "Showdown",
    hasNote: "Ima bilješku",
    filters: {
      label: "Filteri",
      clearAll: "Očisti sve",
      clear: "Bilo koja",
      groupLabel: (group) => `Filter: ${group}`,
      summary: (group, values) => `${group}: ${values}`,
      more: (first, more) => `${first} +${more}`,
      groups: {
        date: "Datum",
        site: "Soba",
        format: "Igra",
        variant: "Varijanta",
        limit: "Limit",
        size: "Stol",
        stakes: "Ulozi",
        position: "Pozicija",
        potType: "Pot",
        result: "Rezultat",
        stack: "Stack",
        allIn: "All-in",
        notes: "Bilješke",
        tags: "Oznake",
        player: "Igrač",
      },
      dates: {
        today: "Danas",
        week: "Zadnjih 7 dana",
        month: "Zadnjih 30 dana",
        year: "Zadnjih 12 mjeseci",
        custom: "Raspon",
        from: "Od",
        to: "Do",
      },
      formats: {
        cash: "Cash",
        tournament: "Turnir",
        sng: "Sit & Go",
        spin: "Spin",
      },
      limits: {
        nl: "No limit",
        pl: "Pot limit",
        fl: "Fixed limit",
      },
      sizes: {
        hu: "Heads-up",
        "6max": "6-max",
        full: "Full ring",
      },
      potTypes: {
        walk: "Walk",
        bomb: "Bomb pot",
        limped: "Limpani",
        "single-raised": "Jedan raise",
        "3bet": "3-bet",
        "4bet+": "4-bet+",
      },
      results: {
        won: "Dobitak",
        lost: "Gubitak",
        even: "Na nuli",
      },
      stacks: {
        "0-40": "Ispod 40 bb",
        "40-80": "40–80 bb",
        "80-120": "80–120 bb",
        "120+": "120 bb i više",
      },
      allIn: {
        yes: "All-in",
        no: "Bez all-ina",
      },
      notes: {
        yes: "S bilješkom",
        no: "Bez bilješke",
      },
      chips: "Žetoni",
      removePlayer: (name) => `Igrač: ${name}. Ukloni ovaj filtar`,
      noTags: "Još nema oznaka. Označi ruku u panelu uz replayer.",
      count: (value) => value,
    },
    saved: {
      button: "Spremljeni filteri",
      title: "Spremljeni filteri",
      none: "Još nema spremljenih filtera.",
      apply: (name) => `Primijeni „${name}”`,
      remove: (name) => `Obriši „${name}”`,
      name: "Naziv",
      namePlaceholder: "npr. BTN 3-bet potovi",
      save: "Spremi trenutne filtere",
      saveFailed: (reason) => `Filter nije spremljen: ${reason}`,
    },
    panel: {
      label: "Ruka",
      choose: "Odaberi ruku s popisa da je ovdje pogledaš u replayeru.",
      loading: "Učitavam ruku…",
      missing: "Ove ruke više nema u tvojem spremištu ruku.",
      failed: (reason) => `Ruka se nije učitala: ${reason}`,
      close: "Zatvori",
      openInWeb: "Otvori na webu",
      openInWebSoon: "Otvaranje ruku na webu stiže sa sinkronizacijom oznaka i bilješki.",
      tags: "Oznake",
      addTag: "Dodaj oznaku",
      tagPlaceholder: "Oznaka, pa Enter",
      removeTag: (tag) => `Ukloni oznaku „${tag}”`,
      tagFailed: (reason) => `Oznaka nije spremljena: ${reason}`,
      note: "Bilješka",
      notePlaceholder: "Što se dogodilo, što pregledati…",
      noteSaved: "Spremljeno",
      noteSaving: "Spremam…",
      noteFailed: (reason) => `Bilješka nije spremljena: ${reason}`,
      localOnly: "Oznake i bilješke zasad ostaju na ovom računalu.",
    },
  },

  players: {
    unavailable: "Igrači su dostupni samo u aplikaciji Rail.",
    storeError: (reason) => `Igrači se nisu učitali: ${reason}`,
    loading: "Učitavam igrače…",
    empty: "Još nema protivnika. Pojavljuju se ovdje dok Rail uvozi ruke iz soba koje prikazuju korisnička imena.",
    noMatch: "Nijedan protivnik ne odgovara.",
    count: (players) => `${n(players)} ${plural(players, "protivnik", "protivnika", "protivnika")}`,
    countOf: (matching, total) => `${n(matching)} od ${n(total)} protivnika`,
    rebuilding: (done, total) =>
      `Ažuriram igrače nakon nadogradnje: ${n(done)} od ${odRuku(total)}. Popis se puni usput.`,
    indexing: (count) =>
      `Rail još razvrstava protivnike iz ${n(count)} ${plural(count, "nedavne ruke", "nedavne ruke", "nedavnih ruku")}; dok ne završi, „ruke s ovim igračem” i raščlamba po poziciji ${plural(count, "izostavljaju tu ruku", "izostavljaju te ruke", "izostavljaju te ruke")}.`,
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
      togetherCash: (count) => `${n(count)} u cash igrama`,
      togetherChips: (count) => `${n(count)} na turnirima`,
      firstSeen: "Prvi put",
      lastSeen: "Zadnji put",
      result: "Tvoj rezultat protiv tog igrača",
      resultCash: "Cash",
      resultChips: "Turniri",
      resultLine: (bb, count) => `${bb} bb kroz ${rukuAcc(count)}`,
      perHundred: (value) => `${value} bb/100`,
      noHands: "Nema ruku",
      handsWith: (count) => `Ruke s ovim igračem (${n(count)})`,
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
      localOnly:
        "Boje, oznake i bilješke zasad ostaju na ovom računalu; poslije će se sinkronizirati s tvojim bilješkama o igračima na webu.",
    },
  },

  reports: {
    unavailable: "Izvještaji su dostupni samo unutar aplikacije Rail.",
    loading: "Zbrajam tvoje ruke…",
    storeError: (reason) => `Izvještaj se nije učitao: ${reason}`,
    empty: "Još nema ruku. Izvještaji se pune kako Rail uvozi tvoje povijesti ruku.",
    noMatch: "Nijedna tvoja ruka ne odgovara ovim filterima.",
    count: (count) => ruku(count),
    rebuilding: (done, total) =>
      `Ažuriram statistiku nakon nadogradnje: ${n(done)} od ${odRuku(total)}. Brojke rastu kako napreduje.`,
    defaultFormat: (format) =>
      `Prikazujem samo: ${format}. Turnirski žetoni i cash ne zbrajaju se u jedan rezultat. Promijeni to čipom Igra.`,
    summary: {
      label: "Sažetak",
      hands: "Ruke",
      result: "Rezultat",
      netBb: "Big blindovi",
      bb100: "bb/100",
      evBb100: "All-in EV bb/100",
    },
    units: {
      mixedKind:
        "Ove ruke miješaju turnirske žetone i cash, pa nema rezultata za zbrojiti ni grafa za nacrtati. Filtriraj na jedan format igre.",
      mixedCurrency:
        "Ove ruke obuhvaćaju više valuta, pa su iznosi u novcu izostavljeni; big blindovi se zbrajaju ispravno.",
    },
    evPending: (count) =>
      `Za ${n(count)} all-in ${plural(count, "ruku", "ruke", "ruku")} equity se još računa u pozadini; dotad ${plural(count, "je", "ih", "ih")} EV linija broji po rezultatu.`,
    graph: {
      heading: "Zarada",
      unit: "Prikaži u",
      bigBlinds: "Big blindovi",
      money: "Novac",
      notEnough: "Još nema dovoljno ruku za krivulju.",
    },
    stats: {
      heading: "Statistika",
      groups: {
        preflop: "Preflop",
        postflop: "Postflop",
        showdown: "Showdown",
        results: "Rezultati",
      },
      note: "Vrijednost blijedi dok je uzorak malen; zadrži pokazivač na njoj za uzorak i 95 % interval.",
    },
    breakdown: {
      heading: "Raščlamba",
      splitBy: "Podijeli po",
      computing: "Brojim…",
      tabs: {
        position: "Pozicija",
        stake: "Ulozi",
        size: "Veličina stola",
        site: "Soba",
        format: "Igra",
        potType: "Tip pota",
        stack: "Dubina stacka",
        players: "Broj igrača",
        street: "Dosegnuta ulica",
        handClass: "Početne ruke",
      },
      heads: {
        position: "Pozicija",
        stake: "Ulozi",
        size: "Stol",
        site: "Soba",
        format: "Igra",
        potType: "Pot",
        stack: "Stack",
        players: "Igrači",
        street: "Ulica",
        handClass: "Ruka",
      },
      unknown: "Nepoznato",
      noPosition: "Bez pozicije",
      headsUp: "Heads-up",
      handed: (players) => `${players} za stolom`,
      stacks: {
        "0-20": "Ispod 20 bb",
        "20-40": "20–40 bb",
        "40-70": "40–70 bb",
        "70-100": "70–100 bb",
        "100-150": "100–150 bb",
        "150-250": "150–250 bb",
        "250+": "250 bb i više",
      },
      streets: {
        preflop: "Preflop",
        flop: "Flop",
        turn: "Turn",
        river: "River",
        showdown: "Showdown",
      },
      empty: "U ovoj podjeli nema ruku.",
    },
    matrix: {
      colourBy: "Boja prema",
      metrics: {
        bb_per_100: "Winrate",
        vpip: "VPIP",
        pfr: "PFR",
        hands: "Podijeljeno",
      },
      gridLabel: "Početne ruke, trinaest puta trinaest",
      cellLabel: (handClass, count) => `${handClass}: ${count === null ? "nikad podijeljena" : ruku(count)}`,
      neverDealt: "nikad podijeljena u ovom uzorku",
      notHoldem: "Mreža je za početne ruke Hold'ema; ove ruke ih nemaju. Tablica navodi svaku klasu.",
      selected: (handClass) => `${handClass} u ovom uzorku`,
    },
  },

  palette: {
    label: "Paleta naredbi",
    placeholder: "Broj ruke, igrač, ekran ili naredba",
    empty: "Ništa nije pronađeno. Upiši broj ruke kako ga je ispisala soba, početak imena igrača ili naredbu.",
    results: (count) =>
      count === 0 ? "Nema rezultata" : `${n(count)} ${plural(count, "rezultat", "rezultata", "rezultata")}`,
    recent: "Nedavno",
    screens: "Ekrani",
    hands: "Ruke",
    reports: "Izvještaji",
    report: (name) => `Izvještaj: ${name}`,
    searching: "Tražim…",
    screen: (name) => name,
    goTo: "idi na otvori ekran",
    hand: (id) => `Ruka #${id}`,
    handDetail: (room, stakes, date) => `${room} · ${stakes} · ${date}`,
    players: "Igrači",
    player: (name) => `Igrač: ${name}`,
    playerDetail: (room, count) =>
      `${room} · ${n(count)} ${plural(count, "zajednička ruka", "zajedničke ruke", "zajedničkih ruku")}`,
    savedFilters: "Spremljeni filteri",
    savedFilter: (screen, name) => `${screen}: ${name}`,
    savedFilterDetail: "Primijeni spremljeni filter",
    settings: "Postavke",
    section: (name) => `Postavke: ${name}`,
    sections: {
      account: "Račun i sinkronizacija",
      folders: "Mape s rukama",
      refused: "Odbijene ruke",
      appearance: "Izgled i jezik",
      startup: "Pokretanje",
      about: "O aplikaciji",
    },
    commands: "Naredbe",
    command: {
      pauseImport: "Pauziraj uvoz",
      resumeImport: "Nastavi uvoz",
      syncNow: "Sinkroniziraj sada",
      themeDark: "Tamna tema",
      themeLight: "Svijetla tema",
      themeSystem: "Tema prema sustavu",
      compact: "Zbijeni popisi i tablice",
      comfortable: "Prozračni popisi i tablice",
      language: "Prebaci na engleski (English)",
      refused: "Prikaži odbijene ruke",
      current: "U uporabi",
    },
    keywords: {
      import: "uvoz mape prati pauziraj nastavi pokreni import",
      sync: "sinkronizacija pošalji web sync",
      theme: "tema tamna svijetla izgled boje theme dark light",
      density: "gustoća zbijeno prozračno retci razmak density compact",
      language: "jezik engleski english hrvatski language",
      refused: "odbijene karantena greške nečitljive refused",
      settings: "postavke opcije settings",
    },
    hints: {
      move: "kretanje",
      open: "otvori",
      close: "zatvori",
    },
  },

  ui: {
    closeNamed: (what) => `Zatvori: ${what.toLowerCase()}`,
  },

  tray: {
    tooltip: "Rail",
    statusIdle: "Još se ne prate mape",
    statusWatching: (folders, handsToday) => `Mape: ${folders} · ruke danas: ${handsToday}`,
    statusPaused: "Uvoz je pauziran",
    statusUnavailable: (folders) => `Mape koje se ne mogu čitati: ${folders}`,
    statusError: "Uvoz nije pokrenut",
    statusImporting: (percent, hands) => `Uvoz ${percent} % · ruke: ${hands}`,
    open: "Otvori Rail",
    pauseImport: "Pauziraj uvoz",
    resumeImport: "Nastavi uvoz",
    quit: "Zatvori Rail",
  },
};

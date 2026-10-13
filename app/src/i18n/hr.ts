import type { Dict } from "./types";

/** Croatian. Prepared, not yet selectable - see `types.ts`. */
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
  },

  placeholder: "Još nije napravljeno.",

  screens: {
    today: {
      title: "Danas",
      lead: "Trenutna sesija: rezultat, broj ruku i status uvoza.",
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
  },

  watch: {
    heading: "Uvoz",
    loading: "Učitavanje…",
    unavailable: "Status uvoza dostupan je samo unutar aplikacije Rail.",
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
    quarantined: (count) => `odbijeno: ${count}`,
    fileErrors: (count) => `nečitljivo: ${count}`,
    pending: (count) => `čeka kraj ruke: ${count}`,
  },

  firstRun: {
    title: "Dobro došli u Rail",
    lead: "Tri koraka do prvog HUD-a: prijava, potvrda mapa s rukama, otvaranje stola.",
    unavailable: "Postavljanje je dostupno samo unutar aplikacije Rail.",
    skip: "Preskoči zasad",

    signIn: {
      heading: "1. Prijava",
      body: "Prijava će usklađivati vaše ruke s webom. Dolazi u jednoj od sljedećih verzija; do tada Rail radi na ovom računalu bez računa.",
      later: "Uskoro",
    },

    folders: {
      heading: "2. Potvrdite mape s rukama",
      searching: "Tražimo mape vaših poker soba…",
      found: (count) => `Rail je na ovom računalu pronašao mapa: ${count}.`,
      lead: "Odznačite mapu koju ne želite. Kasnije to možete promijeniti u Postavkama.",
      room: "Soba",
      folder: "Mapa",
      files: "Datoteke",
      lastHand: "Zadnja ruka",
      watch: (path) => `Prati ${path}`,
      atLeast: (count) => `${count}+`,
      noFiles: "Još nema",
      unknown: "Nepoznato",
      watched: "Već se prati",
      manual: "Dodali ste vi",
      unverified: "Ova zadana mapa još nije potvrđena na stvarnoj instalaciji.",
      notThisRoom: "Najnovije datoteke ovdje ne izgledaju kao ruke ove sobe.",
      empty: "Rail na ovom računalu nije pronašao nijednu mapu s rukama.",
      lookedFor: (rooms) => `Tražio je u zadanim mapama ovih soba: ${rooms}.`,
      noRooms: "Za ovaj sustav još nije poznata zadana mapa nijedne poker sobe.",
      verifying:
        "Zadane mape svake sobe provjeravamo na stvarnim instalacijama, pa ovaj popis raste s novim verzijama. Ako vaša soba sprema ruke negdje drugdje, dodajte mapu sami.",
      addManually: "Ručno dodaj mapu…",
      choosing: "Odabir…",
      existingHeading: "Ruke koje su već u ovim mapama",
      importAll: "Uvezi sve",
      importAllHint: "Sve ruke koje su već tu, a zatim svaku novu dok igrate.",
      onlyNew: "Samo nove ruke",
      onlyNewHint: "Ono što je sada tu ostaje; uvoze se samo ruke odigrane od sada.",
      confirm: (count) => `Prati mape: ${count}`,
      adding: "Dodavanje…",
      added: (count) => `Rail prati mapa: ${count}.`,
      discoverFailed: (reason) => `Traženje mapa nije uspjelo: ${reason}`,
      addFailed: (reason) => `Mape nisu dodane: ${reason}`,
    },

    table: {
      heading: "3. Otvorite stol",
      body: "Igrajte kao i inače. Rail čita svaku ruku čim je soba zapiše, a ekran Danas pokazuje kako stižu.",
      done: "Idi na Danas",
    },
  },

  settings: {
    loading: "Učitavanje…",
    saveFailed: (reason) => `Promjena nije spremljena: ${reason}`,
    unavailable: "Postavke su dostupne samo unutar aplikacije Rail.",

    folders: {
      heading: "Mape s rukama",
      body: "Ponovno potražite mape svojih poker soba ili dodajte mapu ručno.",
      open: "Pronađi mape…",
    },

    appearance: {
      heading: "Izgled",
      theme: "Tema",
      system: "Prema sustavu",
      dark: "Tamna",
      light: "Svijetla",
    },

    startup: {
      heading: "Pokretanje",
      startAtLogin: "Pokreni Rail pri prijavi",
      startAtLoginHint: "Rail se pokreće u traci sustava, spreman za uvoz, bez otvaranja ovog prozora.",
    },

    about: {
      heading: "O aplikaciji",
      version: "Verzija",
      core: "Jezgra",
      handFormat: "Format ruku",
      parsers: (count) => `parsera: ${count}`,
      sites: "Soba u sites.json",
      sitesCount: (count, version) => `${count} (verzija formata ${version})`,
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

  tray: {
    tooltip: "Rail",
    statusIdle: "Još se ne prate mape",
    statusWatching: (folders, handsToday) => `Mape: ${folders} · ruke danas: ${handsToday}`,
    statusPaused: "Uvoz je pauziran",
    statusUnavailable: (folders) => `Mape koje se ne mogu čitati: ${folders}`,
    statusError: "Uvoz nije pokrenut",
    open: "Otvori Rail",
    pauseImport: "Pauziraj uvoz",
    resumeImport: "Nastavi uvoz",
    quit: "Zatvori Rail",
  },
};

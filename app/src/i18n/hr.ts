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

  settings: {
    loading: "Učitavanje…",
    saveFailed: (reason) => `Promjena nije spremljena: ${reason}`,
    unavailable: "Postavke su dostupne samo unutar aplikacije Rail.",

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
    open: "Otvori Rail",
    pauseImport: "Pauziraj uvoz",
    quit: "Zatvori Rail",
  },
};

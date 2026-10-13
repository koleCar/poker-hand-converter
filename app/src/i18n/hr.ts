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
    account: "Postavke računa",
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
    manual: "Dodali ste vi",
    unverified: "Ova zadana mapa još nije potvrđena na stvarnoj instalaciji.",
    notThisRoom: "Najnovije datoteke ovdje ne izgledaju kao ruke ove sobe.",
  },

  importChoice: {
    importAll: "Uvezi sve",
    importAllHint: "Sve ruke koje su već tu, a zatim svaku novu dok igrate.",
    onlyNew: "Samo nove ruke",
    onlyNewHint: "Ono što je sada tu ostaje; uvoze se samo ruke odigrane od sada.",
  },

  firstRun: {
    title: "Dobro došli u Rail",
    lead: "Tri koraka do prvog HUD-a: prijava, potvrda mapa s rukama, otvaranje stola.",
    unavailable: "Postavljanje je dostupno samo unutar aplikacije Rail.",
    skip: "Preskoči zasad",

    signIn: {
      heading: "1. Prijava",
      useOffline: "Koristi bez računa",
      offlineChosen: "Rail radi bez računa. Prijaviti se možete bilo kada u Postavkama, Račun.",
    },

    folders: {
      heading: "2. Potvrdite mape s rukama",
      searching: "Tražimo mape vaših poker soba…",
      found: (count) => `Rail je na ovom računalu pronašao mapa: ${count}.`,
      lead: "Odznačite mapu koju ne želite. Kasnije to možete promijeniti u Postavkama.",
      empty: "Rail na ovom računalu nije pronašao nijednu mapu s rukama.",
      lookedFor: (rooms) => `Tražio je u zadanim mapama ovih soba: ${rooms}.`,
      noRooms: "Za ovaj sustav još nije poznata zadana mapa nijedne poker sobe.",
      verifying:
        "Zadane mape svake sobe provjeravamo na stvarnim instalacijama, pa ovaj popis raste s novim verzijama. Ako vaša soba sprema ruke negdje drugdje, dodajte mapu sami.",
      addManually: "Ručno dodaj mapu…",
      choosing: "Odabir…",
      existingHeading: "Ruke koje su već u ovim mapama",
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

  account: {
    heading: "Račun",
    loading: "Učitavanje…",
    notConfigured: "Ova verzija Raila nema uslugu računa. Sve radi na ovom računalu; ništa se ne sinkronizira.",
    signedOut:
      "Prijavite se da vam ruke budu usklađene s webom. Rail otvara stranicu za prijavu u pregledniku, gdje upravitelj lozinki i prijava Googleom rade kao inače.",
    signIn: "Prijavite se u pregledniku",
    waiting: (time: string) => `Dovršite prijavu u pregledniku (još ${time}).`,
    waitingHint: "Već ste prijavljeni na webu? Potvrdite ondje gumbom Prijavi Rail.",
    openAgain: "Ponovno otvori stranicu",
    cancel: "Odustani",
    signedInAs: (email: string) => `Prijavljeni ste kao ${email}`,
    online: "Povezano.",
    offline: "Izvan mreže. Rail radi dalje i sam se ponovno povezuje.",
    signOut: "Odjava",
    notSignedIn: "Niste prijavljeni: ruke ostaju na ovom računalu.",
    signingInShort: "Prijava u pregledniku…",
    signingOut: "Odjavljivanje…",
    failed: (reason: string) => `Nije uspjelo: ${reason}`,
    notices: {
      cancelled: "Prijava je otkazana u pregledniku.",
      timedOut: "Prijava je trajala dulje od deset minuta. Pokušajte ponovno.",
      notInProgress: "Taj link za prijavu bio je za raniji pokušaj ili je Rail u međuvremenu ponovno pokrenut. Pokušajte ponovno.",
      invalidLink: "Taj link za prijavu nije valjan. Pokušajte ponovno.",
      linkRejected: "Ta prijava je istekla ili je već iskorištena. Pokušajte ponovno.",
      offline: "Rail nije mogao doći do poslužitelja da dovrši prijavu. Provjerite vezu i pokušajte ponovno.",
      sessionEnded:
        "Odjavljeni ste: sesija je završena na poslužitelju (npr. nakon promjene lozinke). Prijavite se ponovno.",
      keychainUnavailable:
        "Rail ne može koristiti sistemski spremnik ključeva, pa će nakon ponovnog pokretanja tražiti prijavu.",
      signedOutLocally: "Odjavljeni ste na ovom računalu. Rail nije mogao doći do poslužitelja da ondje završi sesiju.",
      browserFailed: "Rail nije mogao otvoriti preglednik. Upotrijebite Ponovno otvori stranicu.",
    },
  },

  sync: {
    heading: "Sinkronizacija",
    loading: "Učitavanje…",
    off: "Ova verzija Raila nema sinkronizaciju. Ruke ostaju na ovom računalu.",
    starting: "Pokretanje…",
    signedOut: (waiting) =>
      waiting === 0
        ? "Prijavite se za sinkronizaciju. Do tada ruke ostaju na ovom računalu."
        : `Prijavite se za sinkronizaciju. Do tada na ovom računalu čeka ruku: ${waiting}.`,
    paused: (waiting) =>
      waiting === 0 ? "Sinkronizacija je pauzirana." : `Sinkronizacija je pauzirana. Ruku za slanje: ${waiting}.`,
    mismatch: (owner, email, hands) =>
      `Ruke s ovog računala (${hands}) sinkronizirane su na ${owner}. Sada ste prijavljeni kao ${email}.`,
    mismatchQuestion: (email) => `Prenijeti ih i na ${email}?`,
    mismatchHint:
      "Prijenos ih kopira u knjižnicu ovog računa; ništa se nigdje ne briše. Dok ne odaberete, ništa se ne šalje ni ne preuzima.",
    upload: (email) => `Prenesi na ${email}`,
    keepApart: "Drži ih odvojeno",
    declined: (email) =>
      `Bez sinkronizacije: ruke s ovog računala ostaju odvojene od ${email}. Prijavite se drugim računom za nastavak.`,
    uploadInstead: (email) => `Ipak ih prenesi na ${email}`,
    anotherAccount: "drugi račun",
    syncing: (sent, total) => `Sinkronizacija: ${sent} od ${total} ruku.`,
    speed: (hands, kb) => `Oko ${hands} ruku u sekundi (${kb} KB/s).`,
    capped: (limit) => `Slanje je ograničeno na ${limit} dok se sinkronizira velik zaostatak.`,
    upToDate: "Sve je sinkronizirano.",
    lastSync: (time) => `Zadnja sinkronizacija: ${time}.`,
    offline: (waiting) =>
      waiting === 0
        ? "Izvan mreže. Rail sam nastavlja kad se veza vrati."
        : `Izvan mreže. Ruku na čekanju: ${waiting}; Rail ih sam šalje kad se veza vrati.`,
    rateLimited: (time) => `Ograničenje sinkronizacije računa trenutno je dosegnuto. Rail nastavlja u ${time}.`,
    failed: (reason, time) => `Problem sa sinkronizacijom: ${reason}. Rail pokušava ponovno u ${time}.`,
    retrying: (count) => `Ruke koje se uskoro ponovno šalju: ${count}.`,
    pulled: (count) => `S weba i drugih računala dodano je ruku: ${count}.`,
    pullSkipped: (count) => `Ruke s weba za koje treba novija verzija Raila: ${count}.`,
    rejectedHeading: (count) => `Poslužitelj je odbio ruku: ${count}`,
    rejectedHint: "Ponovno slanje ne pomaže. Nakon nadogradnje Raila pokušajte ponovno.",
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
      syncing: (sent, total) => `Sinkronizacija s webom: ${sent} od ${total} ruku.`,
      waiting: (count) => `Ruku koje čekaju sinkronizaciju: ${count}.`,
      offline: "Izvan mreže: ruke se sinkroniziraju kad se veza vrati.",
      paused: "Sinkronizacija je pauzirana.",
      question: "Sinkronizacija čeka vaš odgovor.",
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
      body: "Rail čita nove ruke iz ovih mapa čim ih vaše poker sobe zapišu.",
      loading: "Učitavanje mapa…",
      notRunning: (reason) => `Uvoz nije pokrenut: ${reason}`,
      loadFailed: (reason) => `Mape se nisu učitale: ${reason}`,
      empty: "Još se ne prati nijedna mapa. Dodajte je ili pustite Rail da potraži mape vaših poker soba.",
      add: "Dodaj mapu…",
      choosing: "Odabir…",
      findAgain: "Ponovno potraži mape",
      setup: "Otvori ekran za postavljanje",
      list: "Praćene mape",

      search: {
        heading: "Mape koje je Rail pronašao",
        searching: "Tražimo mape vaših poker soba…",
        failed: (reason) => `Traženje mapa nije uspjelo: ${reason}`,
        noneNew: "Nema novih mapa: svaka mapa koju Rail poznaje već se prati.",
        found: (count) => `Rail je pronašao mapa koje se još ne prate: ${count}.`,
        existingHeading: "Ruke koje su već u ovim mapama",
        confirm: (count) => `Prati mape: ${count}`,
        adding: "Dodavanje…",
        added: (count) => `Rail sada prati još mapa: ${count}.`,
        close: "Zatvori",
      },

      room: "Soba",
      roomFound: (name) => `${name} (pronašao Rail)`,
      roomChosen: (name) => `${name} (odabrali ste vi)`,
      roomDetected: "Prepoznaje se po datoteci",
      roomAuto: "Prepoznaj po datoteci",
      roomHint:
        "Sobu odaberite samo ako Rail ne prepoznaje ruke iz ove mape: tada se svaka datoteka u njoj čita kao ruke te sobe.",
      lastImport: "Zadnji uvoz",
      never: "Nikad",
      handsToday: "Ruke danas",
      hands: "Ruke",
      files: "Datoteke",
      problems: "Problemi",
      noProblems: "Nema",
      fileErrors: (count) => `datoteke koje se ne mogu čitati: ${count}`,
      pending: (count) => `datoteke koje čekaju kraj ruke: ${count}`,
      quarantined: (count) => `odbijene ruke: ${count}`,

      showRefused: (count) => `Prikaži odbijene ruke (${count})`,
      hideRefused: "Sakrij odbijene ruke",
      refusedHeading: (path) => `Odbijene ruke u ${path}`,
      refusedLoading: "Učitavanje odbijenih ruku…",
      refusedFailed: (reason) => `Odbijene ruke se nisu učitale: ${reason}`,
      refusedEmpty: "Nema odbijenih ruku.",
      refusedLead:
        "Rail nije mogao pročitati ove ruke. Čuvaju se, kako bi ih kasnija verzija mogla pročitati; razlog kaže zašto.",
      byReason: "Po razlogu",
      refusedMore: (shown, total) => `Prikazano je najnovijih ${shown} od ${total}.`,

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
        count === 0 ? "Spremljeno." : `Spremljeno. Datoteke koje se ponovno čitaju kao ruke te sobe: ${count}.`,
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
        "Ako su u novoj mapi iste datoteke (premjestili ste je ili kopirali), Rail nastavlja gdje je stao. Inače čita novu mapu, a ruke već uvezene iz stare ostaju u Railu.",
      moveConfirm: "Koristi novu mapu",
      moving: "Mijenjanje…",
      moved: (moved, detached) =>
        moved === 0
          ? "Gotovo. Rail čita novu mapu; ruke iz stare mape ostaju u Railu."
          : detached === 0
            ? `Gotovo. Datoteke koje nastavljaju gdje su stale: ${moved}.`
            : `Gotovo. Datoteke koje nastavljaju gdje su stale: ${moved}; datoteke kojih tamo nema, a ruke im ostaju: ${detached}.`,

      removeHeading: "Ukloniti ovu mapu?",
      removeBody: (hands) =>
        hands === 0
          ? "Rail je prestaje pratiti. Ništa se u mapi ne briše."
          : `Rail je prestaje pratiti. Ruke koje su već uvezene iz nje (${hands}) ostaju u Railu, a ništa se u mapi ne briše.`,
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

  devStats: {
    heading: "Za razvoj: statistike",
    note: "Samo u debug buildu. Pozadinski posao koji ponovno gradi statistike i računa all-in EV preflop all-inova.",
    activity: "Radi",
    activities: {
      idle: "Ništa",
      rebuilding: "Ponovno gradi statistike",
      computing: "Računa all-in EV",
      "paused-backfill": "Čeka da uvoz završi",
      "paused-tables": "All-in EV čeka dok su stolovi otvoreni",
      stopped: "Zaustavljen",
    },
    rebuild: "Ponovna izgradnja",
    rebuildProgress: (done, total) => `${done} od ${total} ruku`,
    none: "Nema",
    evPending: "Ruke koje čekaju all-in EV",
    evComputed: "Izračunan all-in EV",
    evTime: (n, ms) => `${n} ruku u ${(ms / 1000).toFixed(1)} s`,
    rebuildButton: "Ponovno izgradi statistike",
    evButton: "Ponovno izračunaj all-in EV",
    rebuildStarted: (n) => `Ponovno se grade statistike ${n} ruku.`,
    evQueued: (n) => `${n} ruku čeka all-in EV.`,
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
    total: (count) => `Odbijene ruke: ${count}.`,
    byReason: "Po razlogu",
    pickReason: "Odaberi razlog da vidiš njegove ruke.",
    ofReason: (reason) => `Ruke odbijene kao ${reason}`,
    more: (shown, total) => `Prikazano je ${shown} najnovijih od ${total}.`,
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
      `Ruke odbijene u starijoj verziji parsera: ${hands} (datoteke: ${files}). Ova ih verzija možda može pročitati.`,
    upToDate: "Ove su ruke odbili parseri ove verzije.",
    retried: (files) => (files === 0 ? "Nema ničeg za ponovno čitanje." : `Ponovno se čitaju datoteke: ${files}.`),
    retryFailed: (reason) => `Ponovno čitanje nije uspjelo: ${reason}`,
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

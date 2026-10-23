/**
 * Croatian (R2.8: chosen in Settings, Appearance). The web's register: the
 * reader is "ti", and sentences avoid the past tense of the second person,
 * which would need the reader's gender ("Prijava: ..." rather than
 * "Prijavljen si ..."). A count picks its noun's form with the shared
 * `plural` (one / few / many: 1 ruka, 2 ruke, 5 ruku) and is grouped the
 * Croatian way (`countIn`: 1.204). Poker's own words (pot, stack, showdown,
 * all-in, board) stay as Croatian players say them, as on the web.
 */
import { handsUiHr } from "@rail/ui/strings/hands.hr";
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
      lead: "Što pokazuju paneli HUD-a, za kojim stolovima, s pregledom.",
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

    custom: {
      heading: "Vlastite statistike",
      body: "Broji ono što standardne statistike ne broje. Brojač je pravilo nad svakom odlukom u tvojim rukama - kada je odluka prilika i što se računa kao iskorištena prilika - a statistika ga prikazuje kroz formulu, s vlastitom oznakom, bojama i minimalnim uzorkom. Rail novi brojač prebroji kroz sve tvoje ruke u pozadini; Izvještaji ga prikazuju uz ostale statistike.",
      loading: "Učitavanje vlastitih statistika…",
      loadFailed: (reason) => `Vlastite statistike nisu učitane: ${reason}`,
      empty: "Još nema vlastitih statistika.",
      list: "Vlastite statistike",
      columns: {
        name: "Statistika",
        value: "Sve tvoje ruke",
        status: "Prebrojano",
        actions: "Radnje",
      },
      add: "Nova statistika",
      edit: "Uredi",
      editNamed: (name) => `Uredi: ${name}`,
      delete: "Obriši",
      deleteNamed: (name) => `Obriši: ${name}`,
      deleteHeading: "Obrisati ovu statistiku?",
      deleteBody: (name) => `${name} i sve što je za nju prebrojano nestaje. Ruke ostaju kakve jesu.`,
      deleteConfirm: "Obriši statistiku",
      deleting: "Brisanje…",
      deleteRefused: (reader) => `${reader} čita brojače ove statistike. Prvo promijeni ili obriši nju.`,
      counting: (done, total) => `Brojanje: ${n(done)} od ${odRuku(total)}`,
      counted: (total) => `Kroz ${rukuAcc(total)}`,
      formulaOnly: "Iz standardnih brojača",
      broken: "Ova verzija Raila ne može je prikazati:",
      form: {
        newHeading: "Nova statistika",
        editHeading: (name) => `Uredi: ${name}`,
        name: "Naziv",
        nameHint: "Kako je navode tablice i izvještaji.",
        label: "Kratka oznaka",
        labelHint: "Što ispisuje HUD panel: nekoliko znakova.",
        description: "Opis",
        descriptionHint: "Jedna rečenica; prikazuje se kad pokazivač stane na naziv.",
        id: "Id",
        idHint: "Formule po njemu zovu brojač: id za iskorištene prilike, id_opp za prilike. Mala slova, znamenke i _.",
        group: "Skupina",
        groups: {
          preflop: "Preflop",
          postflop: "Postflop",
          showdown: "Showdown",
          results: "Rezultati",
        },
        predicate: "Brojač",
        predicateHint:
          "Prazno: formula samo nad standardnim brojačima. Inače počni s first, any ili each; zatim kada je odluka prilika; iza => što se računa kao iskorištena prilika. Primjer: first street = flop and facing_cbet => action = fold",
        formula: "Formula",
        formulaHint: (id) =>
          `Prazno: pct(${id}, ${id}_opp), koliko je često prilika iskorištena. Brojevi, + - * /, pct(iskorišteno, prilike), sum(...) i naziv svakog brojača.`,
        unit: "Prikaz",
        units: {
          percent: "Postotak",
          ratio: "Omjer",
          count: "Broj",
          bb: "Big blindovi",
          bb_per_100: "bb/100",
          money: "Novac",
        },
        decimals: "Decimale",
        sampleMin: "Puna težina od",
        sampleMinHint: "Ispod ovog uzorka vrijednost blijedi u tablicama i na HUD-u.",
        sampleOf: "Uzorak",
        sampleOfHint: "Formula za uzorak; potrebna kad formula nije pct(iskorišteno, prilike).",
        bands: "Boje",
        bandsHint: "Vrijednost ispod granice dobiva boju tog pojasa; posljednji pojas dobiva ostatak. Bez pojaseva: bez boje.",
        below: "Ispod",
        rest: "Ostatak",
        remove: "Ukloni",
        addBand: "Dodaj pojas",
        removeBand: (index) => `Ukloni pojas ${index}`,
        tones: {
          "very-low": "Vrlo nisko",
          low: "Nisko",
          normal: "Uobičajeno",
          high: "Visoko",
          "very-high": "Vrlo visoko",
        },
        save: "Spremi",
        saving: "Spremanje…",
        cancel: "Odustani",
        nameMissing: "Upiši naziv i kratku oznaku.",
        checking: "Provjera…",
        problems: "Što popraviti",
        preview: "Pregled",
        previewSample: (count) => `Na tvojih zadnjih ${ruku(count)}`,
        previewAll: (count) => `Kroz sve tvoje ruke (${ruku(count)})`,
        previewCounts: (made, opp) => `Iskorišteno ${n(made)} ${plural(made, "put", "puta", "puta")} od ${n(opp)} ${plural(opp, "prilike", "prilike", "prilika")}`,
        noValue: "Nema vrijednosti: u ovim rukama nema prilike.",
        afterSave: "Nakon spremanja Rail je prebroji kroz sve tvoje ruke u pozadini.",
        saveFailed: (reason) => `Spremanje nije uspjelo: ${reason}`,
        reference: "Polja i primjeri",
        fields: "Polja koja brojač može čitati",
        fieldKinds: {
          bool: "da ili ne",
          number: "broj",
          choice: "jedno od",
        },
        examples: "Primjeri (klikni jedan da ga upotrijebiš)",
        exampleNames: {
          cbet3bet: "Cbet na flopu u 3-bet potovima",
          foldCbetMultiway: "Fold na cbet na flopu, multiway",
          smallCbet: "Mali cbet na flopu (40 % pota ili manje)",
          bigOpen: "Open raise veći od 3 big blinda",
          shortShove: "Open shove s 15 big blindova ili manje",
          riverCallBig: "Call na riveru protiv beta od pota ili više",
        },
      },
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
      rebuilding: "Ponovno računa statistike",
      indexing: "Razvrstava protivnike novih ruku",
      counting: "Broji tvoje statistike",
      computing: "Računa all-in EV",
      "recomputing-ev": "Ponovno računa all-in EV",
      "paused-backfill": "Čeka da uvoz završi",
      "paused-tables": "Ponovni izračun i all-in EV čekaju dok su stolovi otvoreni",
      stopped: "Zaustavljen",
    },
    rebuild: "Ponovni izračun",
    rebuildProgress: (done, total) => `${n(done)} od ${odRuku(total)}`,
    evRecompute: "All-in EV ponovno",
    none: "Nema",
    evPending: "Ruke koje čekaju all-in EV",
    evComputed: "Izračunan all-in EV",
    evTime: (count, ms) => `${ruku(count)} u ${(ms / 1000).toFixed(1).replace(".", ",")} s`,
    rebuildButton: "Ponovno izgradi statistike",
    evButton: "Ponovno izračunaj all-in EV",
    rebuildStarted: (count) => `Statistika se ponovno računa za ${rukuAcc(count)}.`,
    evQueued: (count) => `All-in EV ponovno se računa za ${rukuAcc(count)}.`,
  },

  recompute: {
    rows: (done, total) =>
      `Ažuriram tvoju statistiku za ovu verziju Raila: ${n(done)} od ${odRuku(total)}. Dok ne završi, vidiš dosadašnje brojke.`,
    segments: (done, total) =>
      `Ponovno grupiram tvoju statistiku po igrama: ${n(done)} od ${odRuku(total)}. Dok ne završi, vidiš dosadašnje grupiranje.`,
    ev: (done, total) =>
      `Ponovno računam all-in EV: ${n(done)} od ${odRuku(total)}. Dok ne završi, vidiš dosadašnji all-in EV.`,
    filling: (done, total) =>
      `Računam tvoju statistiku: ${n(done)} od ${odRuku(total)}. Brojke rastu kako napreduje.`,
    pausedTables: "Čeka dok su stolovi otvoreni.",
    pausedImport: "Čeka da uvoz završi.",
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
    // The list, the filter row and the saved filters: the shared screen's words
    // (R4.5b, `@rail/ui/strings/hands.hr.ts`).
    ...handsUiHr,
    unavailable: "Tvoje ruke dostupne su samo u aplikaciji Rail.",
    empty: "Još nema ruku. Pojavit će se ovdje čim ih Rail uveze iz tvojih mapa s poviješću ruku.",
    rebuilding: (done, total) =>
      `Popis ruku osvježava se nakon nadogradnje: ${n(done)} od ${odRuku(total)}. Popis se puni usput.`,
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
      potOddsHidden: "Pot odds su skriveni dok je otvoren poker stol: Rail ne pomaže tijekom igre.",
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
      yours: (name) => `${name} (vlastita)`,
    },
    breakdown: {
      heading: "Raščlamba",
      splitBy: "Podijeli po",
      computing: "Brojim…",
      handClassHidden:
        "Početne ruke su skrivene dok je otvoren poker stol: Rail tijekom igre ne prikazuje tablice ruku. Vraćaju se kad se stolovi zatvore.",
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
      statistics: "Vlastite statistike",
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

  duringPlay: {
    hidden: "Skriveno dok je otvoren poker stol: Rail ne pomaže tijekom igre. Vraća se kad se stolovi zatvore.",
  },

  hudStatus: {
    heading: "Za stolovima",
    loading: "Učitavanje stanja HUD-a…",
    failed: (reason) => `Stanje HUD-a nije učitano: ${reason}`,
    unavailable: "Stanje HUD-a dostupno je samo u aplikaciji Rail.",
    off: "HUD nije pokrenut.",
    offWhy: (reason) => `HUD nije pokrenut: ${reason}`,
    starting: "HUD se pokreće…",
    running: "HUD radi.",
    noTables: "Nije otvoren nijedan stol sobe koju Rail poznaje.",
    attached: (count) => `Na ${n(count)} ${plural(count, "stolu", "stola", "stolova")}:`,
    attachedLabel: "Stolovi s HUD-om",
    tableAt: (room, table) => `${room} · ${table}`,
    untitled: "stol bez imena u naslovu",
    waiting: "čeka prvu ruku za stolom",
    refusedHeading: (count) => `${n(count)} ${plural(count, "stol", "stola", "stolova")} bez HUD-a`,
    refusedLabel: "Stolovi bez HUD-a",
    why: {
      prohibited: (room) => `Pravila sobe ${room} ne dopuštaju HUD.`,
      withdrawn: (room) =>
        `Pravila sobe ${room} više ne dopuštaju HUD: isključila ga je ponovna provjera nakon izlaska ove verzije Raila.`,
      unknown: (room) => `Pravila sobe ${room} o HUD-u nisu utvrđena, a Rail nepoznato smatra zabranjenim.`,
      notARoom: (room) =>
        `${room} je mreža soba, a ne jedna soba: odlučuju pravila svake sobe, a nijedna nije potvrđena.`,
      unknownSite: "Ovaj prozor ne pripada nijednoj sobi koju Rail poznaje.",
    },
    policyLink: "Pravila sobe",
    policyPage: (room) => `Pravila sobe ${room}, na njezinim stranicama`,
    checked: (date) => `provjereno ${date}`,
    noOverride: "Ovdje namjerno nema prekidača za uključivanje HUD-a: Rail crta samo za stolovima sobe koja to dopušta.",
    explainSummary: "Zašto ovdje ne mogu uključiti HUD?",
    explain1:
      "Mnoge poker sobe zabranjuju HUD ili mu postavljaju pravila, a kršenje tih pravila može stajati račun. Zato se Railov HUD veže uz stol samo kad to dopuštaju pravila same sobe: način usklađenosti, uvijek uključen.",
    explain2:
      "Za svaku sobu Rail čuva pravilo pročitano na stranicama same sobe, adresu te stranice i datum čitanja. Soba čija pravila zabranjuju HUD ili nisu jasna nema HUD: nepoznato znači ne.",
    explain3:
      "Popis se ponovno provjerava prije svakog izdanja, a između izdanja Rail preuzima ispravljeni popis s weba. Ažuriranje sobu može samo isključiti ili joj dodati ograničenje, nikad uključiti: za to treba nova verzija Raila.",
    explain4:
      "Statistika, izvještaji i tvoje ruke rade u svakoj sobi. Ako pravila neke sobe kažu drukčije nego Rail, javi nam s poveznicom na njih.",
    roomsHeading: "Gdje se HUD smije koristiti",
    allowedLead: "Dopušteno, unutar pravila svake sobe:",
    notAllowedLead: (count) =>
      `Sobe u kojima nije dopušteno: ${n(count)} (zabranjeno ili pravila nisu utvrđena)`,
    noneAllowed: "Nijedna soba: popis ne dopušta nijednu.",
    listShipped: "Popis soba: onaj s kojim je došla ova verzija Raila.",
    listRemote: (date) => `Popis soba: ažuriran s weba ${date}. Ažuriranja ga mogu samo pooštriti.`,
    lastUpdated: (time) => `Provjera ažuriranja ${time}: na snazi je noviji popis.`,
    lastCurrent: (time) => `Provjera ažuriranja ${time}: nema novijeg.`,
    lastRefused: (time) =>
      `Provjera ažuriranja ${time}: datoteka nije bila ispravna i nije upotrijebljena; vrijedi postojeći popis.`,
    lastFailed: (time) => `Provjera ažuriranja ${time}: web nije dostupan; vrijedi postojeći popis.`,
    checkNow: "Provjeri ažuriranje sada",
    checking: "Provjera…",
    notes: "Nije preuzeto iz ažuriranja jer bi ublažilo pravila:",
    permission: {
      heading: "Rail treba dopuštenje Pristupačnost da bi vidio tvoje stolove",
      why: "Na Macu Railov HUD pronalazi poker stol po naslovu njegova prozora, a macOS aplikaciji dopušta čitanje naslova tuđih prozora samo uz dopuštenje Pristupačnost. Rail čita naslove i položaj prozora: ništa drugo.",
      not: "Rail ne snima zaslon, ne čita što tipkaš ili klikaš i ne upravlja drugim aplikacijama. Ne trebaju mu Snimanje zaslona ni Praćenje unosa.",
      steps:
        "Klikni gumb: macOS će pitati za Rail, a Postavke sustava otvorit će se na Privatnost i sigurnost, Pristupačnost. Ondje uključi Rail. Ovaj zaslon to sam primijeti.",
      open: "Otvori Postavke sustava",
      opening: "Otvaranje…",
      waiting: "Čekam dopuštenje. Rail provjerava svakih nekoliko sekundi.",
      failed: (reason) =>
        `Postavke sustava nisu se otvorile (${reason}). Otvori ih sam: Privatnost i sigurnost, Pristupačnost.`,
      stale:
        "Rail je u popisu već uključen, a ova poruka ne nestaje? Ukloni Rail iz popisa gumbom minus i ponovno ga uključi: macOS može čuvati dopuštenje za stariju kopiju Raila.",
      granted: "Dopuštenje Pristupačnost je dano: HUD vidi tvoje stolove.",
      noClient: "HUD na macOS-u: nije pokrenut nijedan podržani poker klijent.",
    },
    today: {
      off: "HUD: nije pokrenut",
      starting: "HUD: pokreće se…",
      none: "HUD: nema otvorenog stola",
      permission: "HUD: treba dopuštenje Pristupačnost",
      noClient: "HUD na macOS-u: nije pokrenut nijedan podržani poker klijent",
      tables: (count) => `HUD: na ${n(count)} ${plural(count, "stolu", "stola", "stolova")}`,
      refused: (count, rooms) =>
        `bez njega: ${n(count)} ${plural(count, "stol", "stola", "stolova")} (${rooms}: nije dopušteno)`,
      details: "Detalji HUD-a",
    },
  },

  hudPopup: {
    label: (player) => `${player}: HUD prozor`,
    close: "Zatvori (Esc)",
    loading: "Učitavam…",
    failed: (reason) => `Nije učitano: ${reason}`,
    none: "Klikni panel igrača za stolom da ovdje vidiš njegove brojke.",
    you: "Ti",
    tableAt: (room, table) => `${room} · ${table}`,
    opaque: "Ova soba skriva imena igrača: brojke su samo iz ove sesije, a za to mjesto nema bilješki.",
    sample: (count) => `Kroz ${rukuAcc(count)}`,
    ownHands: "Samo tvoje odigrane ruke, kako traže pravila ove sobe.",
    together: "Zajedničke ruke",
    noTogether: "Još nijedna",
    result: "Tvoj rezultat protiv ovog igrača",
    resultCash: (bb, count) => `Cash: ${bb} bb kroz ${rukuAcc(count)}`,
    resultChips: (bb, count) => `Turniri: ${bb} bb kroz ${rukuAcc(count)}`,
    stats: "Statistike",
    statsNote: "Samo prošle ruke, kao na stolu. Vrijednost blijedi dok je uzorak malen; prijeđi mišem preko nje za uzorak i interval od 95 %.",
    legend: "Boje",
    legendNote: (thresholds) =>
      `Što znači koja boja, statistiku po statistiku: ${thresholds === 1 ? "prag koji vrijedi" : "pragovi koji vrijede"} za stolovima ove sobe. Na stolu: - nisko, = uobičajeno, + visoko.`,
    tones: {
      "very-low": "vrlo nisko",
      low: "nisko",
      normal: "uobičajeno",
      high: "visoko",
      "very-high": "vrlo visoko",
    },
    below: (value) => `ispod ${value}`,
    from: (value) => `od ${value}`,
    range: (low, high) => `${low} do ${high}`,
    byPosition: "Po poziciji",
    byPositionHidden: (room) =>
      `Ne prikazuje se za stolovima sobe ${room}: soba ne dopušta HUD čiji se prikaz mijenja s pozicijom.`,
    noPosition: "Bez pozicije",
    note: "Bilješka",
    wordsHidden: (room) =>
      `${room} ne dopušta označavanje igrača za stolom, pa tvoje bilješke, boje i oznake za njih ostaju na Railovu ekranu Igrači.`,
    openInApp: "Otvori u Railu",
    historical: "Statistike samo iz prošlih ruku: Rail ne daje savjete i ne prikazuje ništa o ruci koja se igra.",
  },

  hudEditor: {
    loading: "Učitavam izglede HUD-a…",
    failed: (reason: string) => `Izgledi HUD-a nisu učitani: ${reason}`,
    designs: "Izgledi",
    designPicker: "Izgled za uređivanje",
    presetsGroup: "Preseti",
    yoursGroup: "Tvoji izgledi",
    presetName: (name: string) => `${name} (preset)`,
    newFrom: "Novi izgled od",
    create: "Napravi",
    copyOf: (name: string) => `${name}, moja kopija`,
    name: "Naziv",
    format: "Namijenjen za",
    formats: { cash: "Cash", mtt: "Turnir", spin: "Spin" },
    presetReadOnly: "Preset se ne može mijenjati: napravi svoju kopiju da ga urediš.",
    makeCopy: "Napravi moju kopiju",
    save: "Spremi",
    saving: "Spremam…",
    saved: "Spremljeno. HUD ga odmah crta.",
    notSaved: "Nije spremljeno:",
    unsaved: "Nespremljene promjene",
    discard: "Odbaci promjene",
    resetToPreset: (name: string) => `Vrati na ${name}`,
    delete: "Obriši izgled",
    deleteConfirm: (name: string) => `Obrisati ${name}? Stolovi na kojima se koristio vraćaju se na svoj preset.`,
    deleteYes: "Obriši",
    cancel: "Odustani",
    deleted: "Obrisano.",

    panel: "Panel",
    panelHint:
      "Povuci statistiku s popisa na panel ili na njoj pritisni Dodaj. Povuci ćeliju da je premjestiš. Kad je ćelija u fokusu: Alt+lijevo i Alt+desno je pomiču, Delete je uklanja.",
    cellsLabel: "Ćelije panela",
    cellsHeading: "Ćelije",
    cellLabel: (label: string, index: number) => `${label}, ćelija ${index}`,
    cellWhen: "po stacku",
    dropHere: "Spusti ovdje",
    emptyPanel: "Spusti statistiku ovdje da započneš panel.",
    columns: "Ćelija u redu",
    thresholds: "Boje po",
    thresholdsAll: "Svim pojasevima definicije",
    thresholdsN: (n: number) =>
      n === 0 ? "Bez boja" : n === 1 ? "1 pragu (nisko, normalno)" : `Najviše ${n} praga`,
    legend: "Prikaži legendu boja na stolu",
    labels: "Prikaži moje boje, oznake i oznaku bilješke",
    labelsHint: "Gdje soba dopušta: Winamax. Nikad na PokerStarsu ni ACR-u, koji zabranjuju označavanje igrača.",
    announceAdded: (label: string, index: number) => `${label} dodana kao ćelija ${index}.`,
    announceMoved: (label: string, index: number) => `${label} premještena na ćeliju ${index}.`,
    announceRemoved: (label: string) => `${label} uklonjena s panela.`,
    full: (max: number) => `Panel ima najviše ${max} ćelija.`,

    palette: "Statistike",
    paletteSearch: "Nađi statistiku",
    paletteHint: "Tvoje su označene; označena je i ona koja čita karte: PokerStars je ne dopušta.",
    add: "Dodaj",
    addNamed: (label: string) => `Dodaj ${label} na panel`,
    onPanel: "na panelu",
    yours: "tvoja",
    cards: "čita karte",
    noMatch: "Nijedna statistika ne odgovara.",

    cell: "Ćelija",
    cellNone: "Odaberi ćeliju panela da promijeniš kako se prikazuje.",
    moveEarlier: "Pomakni ranije",
    moveLater: "Pomakni kasnije",
    remove: "Ukloni s panela",
    decimals: "Decimale",
    minSample: "Puna boja od uzorka od",
    asDefinition: (value: string) => `Kao u definiciji (${value})`,
    bands: "Pojasevi boja",
    bandsOwn: "Koristi moje pojaseve",
    bandsHint: "Vrijednosti ispod svake granice dobivaju njezinu boju; zadnji pojas drži ostatak. Granice rastu.",
    bandBelow: (n: number) => `Pojas ${n}: ispod`,
    bandTone: (n: number) => `Pojas ${n}: boja`,
    removeBand: (n: number) => `Ukloni pojas ${n}`,
    addBand: "Dodaj pojas",
    tones: {
      "very-low": "Vrlo nisko",
      low: "Nisko",
      normal: "Normalno",
      high: "Visoko",
      "very-high": "Vrlo visoko",
    },
    stackLegend: "Dubina stacka",
    stack: "Prikaži samo pri nekim dubinama stacka",
    stackHint: "Panel se tada mijenja sa stackom: PokerStars i Winamax to ne dopuštaju, ACR dopušta.",
    stackBelow: "Ispod (velikih blindova)",
    stackAtLeast: "Od (velikih blindova)",

    popup: "Skočni prozor",
    popupHint: "Što pokazuje klik na panel, odjeljak po odjeljak.",
    section: (n: number) => `Odjeljak ${n}`,
    sectionTitle: "Naslov",
    sectionTitleDefault: "Naziv grupe",
    addSection: "Dodaj odjeljak",
    removeSection: (n: number) => `Ukloni odjeljak ${n}`,
    addToSection: "Dodaj statistiku",
    removeFromSection: (label: string) => `Ukloni ${label}`,
    moveUp: (label: string) => `Pomakni ${label} gore`,
    popupShipped: "Skočni prozor navodi Railove statistike; tvoje su na panelu.",

    preview: "Pregled",
    previewHint: "Izmišljeni igrači i brojevi, raspoređeni točno kako HUD crta ovaj izgled za stolovima ove sobe.",
    room: "Soba",
    seats: "Mjesta",
    seatsN: (n: number) => (n === 2 ? "Heads-up" : `${n}-max`),
    previewFailed: (reason: string) => `Nema pregleda: ${reason}`,
    previewLabel: (room: string, seats: string) => `Izgled za stolom ${seats} u sobi ${room}`,
    stackBb: (bb: number) => `${bb} bb`,
    dragged: (count: number) =>
      count === 1
        ? "1 panel je gdje si ga povukao za ovu veličinu stola."
        : `Panela gdje si ih povukao za ovu veličinu stola: ${count}.`,
    resetDragged: "Vrati povučene panele",
    resetDone: (count: number) => (count === 1 ? "1 panel je vraćen na mjesto." : `Vraćeno panela: ${count}.`),
    preferredSeat: "Moj klijent me uvijek posjeda dolje",
    preferredSeatAuto: "Kako kažu postavke sobe",
    preferredSeatYes: "Da, okreće stol",
    preferredSeatNo: "Ne, mjesta ostaju numerirana",

    rooms: "Gdje se smije koristiti",
    roomOk: (room: string) => `${room}: smije se koristiti.`,
    roomRefused: (room: string) => `${room}: ne smije se koristiti -`,
    roomNotes: (room: string) => `${room}: smije se koristiti; tamo -`,

    assignments: "Koji izgled dobiva koji stol",
    assignmentsHint:
      "Odaberi izgled za sobu i igru, za sve veličine stola ili jednu. Najodređeniji izbor pobjeđuje: soba, pa igra, pa veličina; bez izbora vrijedi preset igre.",
    allRooms: "Sve sobe",
    sizeFilter: "Veličina stola",
    allSizes: "Sve veličine",
    assignTo: (room: string, format: string, size: string) => `Izgled za ${format} u sobi ${room}, ${size}`,
    inherit: (name: string) => `Zadano: ${name}`,
    allFormats: "Svaka igra",
    notSet: "Nije postavljeno",
    assignedHere: "odabrano ovdje",
    assignRefused: (room: string) => `Ne za ${room}:`,
    assignedProblems: (room: string) => `U sobi ${room} HUD izostavlja:`,

    problems: {
      version: "Ovaj izgled napravio je noviji Rail.",
      nameTooLong: "Naziv je predug.",
      noCells: "Panel treba barem jednu statistiku.",
      tooManyCells: "Panel ima previše ćelija.",
      columns: "Odaberi od 1 do 6 ćelija u redu.",
      tooManyPopup: "Skočni prozor ima previše odjeljaka ili statistika.",
      titleTooLong: "Naslov odjeljka je predug.",
      labels: "tvoje boje, oznake i bilješke (soba zabranjuje označavanje igrača)",
      roomNotAllowed: "Soba ne dopušta HUD.",
      unknownStat: (stat: string) => `${stat} više nije statistika.`,
      duplicateStat: (stat: string) => `${stat} je dvaput na panelu.`,
      heroOnlyStat: (stat: string) => `${stat} se odnosi samo na tvoje ruke; panel prikazuje svakog igrača.`,
      moneyStat: (stat: string) => `${stat} je novac: novac protivnika nikad se ne prikazuje.`,
      badWhen: (stat: string) => `${stat}: raspon stacka je prazan.`,
      badBands: (stat: string) => `${stat}: granice pojaseva moraju rasti, a zadnji pojas nema granicu.`,
      badDecimals: (stat: string) => `${stat}: najviše 2 decimale.`,
      badSample: (stat: string) => `${stat}: uzorak je prevelik.`,
      cardSplit: (stat: string) => `${stat} čita karte (soba zabranjuje statistike podijeljene po kartama)`,
      gameStateSwitching: (stat: string) =>
        `${stat} se prikazuje po dubini stacka (soba zabranjuje prikaz koji se mijenja sa stackom)`,
      colourThresholds: (stat: string, count: number, max: number) =>
        `${stat} je obojena po ${count} praga (soba dopušta ${max})`,
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
    hudOff: "HUD isključen",
    hudStarting: "HUD se pokreće…",
    hudTables: (attached, refused) =>
      `${attached === 0 ? "HUD: nema otvorenog stola" : `HUD: stolovi: ${attached}`}${
        refused === 0 ? "" : ` · nije dopušteno: ${refused}`
      }`,
    quit: "Zatvori Rail",
  },
};

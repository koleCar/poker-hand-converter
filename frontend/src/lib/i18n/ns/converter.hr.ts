import { plural } from "../plural";
import type { Dict } from "../types";

/** Strings for the converter components, Croatian. Same shape as `converter.en.ts`. */

const num = (value: number) => value.toLocaleString("hr-HR");
/** 1 ruka, 2 ruke, 5 ruku. */
const ruka = (count: number) => plural(count, "ruka", "ruke", "ruku");
/** "1 ruka pretvorena", "2 ruke pretvorene", "5 ruku pretvoreno". */
const converted = (count: number) =>
  `${num(count)} ${plural(count, "ruka pretvorena", "ruke pretvorene", "ruku pretvoreno")}`;

export const converterHr: Dict["converter"] = {
  upload: {
    or: "ili",
    pastePlaceholder: "Ovdje zalijepi ruku",
    reading: "Čitam…",
    replayIt: "Odigraj je",
    chooseFile: "Odaberi datoteku",
    notRecognised: "To nije hand history koji prepoznajemo.",
    couldNotRead: "To nije moguće pročitati.",
    fileCouldNotRead: "Tu datoteku nije moguće pročitati.",
    manyFound: (count: number) =>
      `${plural(count, "Pronađena je", "Pronađene su", "Pronađeno je")} ${num(count)} ${ruka(count)} — prikazujem prvu. Za pretvaranje svih koristi okvir za učitavanje ispod.`,
  },

  save: {
    signInReason: "Prijavi se da zadržiš ovu ruku. Vidjet ćeš je samo ti.",
    alreadySaved: "Već je u tvojoj biblioteci.",
    saved: "Spremljeno u tvoju biblioteku.",
    failed: "Spremanje nije uspjelo.",
    button: "Spremi u moju biblioteku",
    saving: "Spremam…",
  },

  drop: {
    veil: "Ispusti bilo gdje za pretvaranje",
    title: "Ispusti datoteke ili cijelu izvezenu mapu",
    chooseFiles: "Odaberi datoteke",
    chooseFolder: "Odaberi mapu",
    moreSites: (listed: string, more: number) => `${listed} i još ${num(more)}`,
  },

  batch: {
    unknownFormat: "Format koji još ne poznajemo",
    readFailed: "Te datoteke nije moguće pročitati.",
    pastedText: "Zalijepljeni tekst",
    pastedTextNumbered: (index: number) => `Zalijepljeni tekst ${index}`,
    autoSave: "Spremi u moju biblioteku",
    autoSaveUnavailable: "Nije dostupno u ovoj verziji.",
    autoSaveSignedOut: "Pretvori sad, prijavi se poslije.",
    startOver: "Kreni ispočetka",
    dbNotConfigured:
      "Baza podataka nije spojena. Postavi NEXT_PUBLIC_SUPABASE_URL i NEXT_PUBLIC_SUPABASE_ANON_KEY za spremanje, pregledavanje i dijeljenje ruku. Pretvaranje i preuzimanje rade i bez nje.",
    held: (count: number) => `${converted(count)}. Prijavi se da ${count === 1 ? "je" : "ih"} zadržiš.`,
    heldSignInReason: (count: number) =>
      `Prijavi se da spremiš ${num(count)} ${plural(count, "pretvorenu ruku", "pretvorene ruke", "pretvorenih ruku")} u svoju biblioteku.`,
    signInAndSave: "Prijavi se i spremi",
    notNow: "Ne sada",
    readingFiles: "Čitam tvoje datoteke…",
    convertingFile: (name: string) => `Pretvaram ${name}`,
    converting: "Pretvaram…",
    stop: "Zaustavi",
    progressDetail: (handsDone: number, files: number, fileIndex: number, percent: number) =>
      `${converted(handsDone)}${files > 1 ? ` · datoteka ${num(fileIndex)} od ${num(files)}` : ` · ${percent} %`}`,
    noWorker:
      "Ovaj preglednik nije htio pokrenuti pozadinski worker, pa je pretvaranje radilo na samoj stranici. Velike datoteke zato su se mogle činiti sporima.",
    workerStopped: "Pretvaranje se neočekivano zaustavilo.",
  },

  problems: {
    empty: "Datoteka je prazna.",
    noText: "U datoteci nema teksta.",
    binary: "Ovo izgleda kao binarna datoteka, a ne hand history. Provjeri jesi li odabrao/la pravu datoteku.",
    notZip: "Ovo nije zip arhiva koju možemo pročitati.",
    encryptedEntry: "Šifrirane datoteke u zip arhivi nisu podržane.",
    zip64: "Zip64 arhive nisu podržane. Raspakiraj arhivu i ubaci datoteke.",
    cannotUnzip: "Ovaj preglednik ne zna raspakirati datoteke. Raspakiraj arhivu sam/a i ubaci .txt datoteke.",
    unreadableEntry: "Ovu datoteku iz arhive nije moguće pročitati.",
    emptyArchive: "U arhivi nema datoteka.",
    tooLarge: (size: string) => `Ta datoteka ima ${size}. Hand historyji nisu toliko veliki — ova se preskače.`,
    unreadableFile: "Ovu datoteku nije moguće pročitati.",
    nothingPasted: "U okviru nije bilo ničega.",
  },

  results: {
    heading: (count: number, stopped: boolean) => `${converted(count)}${stopped ? " zasad" : ""}`,
    savingOffBuild: "Spremanje je isključeno u ovoj verziji — preuzmi datoteku da zadržiš svoje ruke.",
    savingSwitchedOff: "Spremanje je isključeno. Tvoje ruke ostaju samo u ovoj kartici.",
    savingProgress: (done: number, total: number) => `Spremam u tvoju biblioteku… ${num(done)} od ${num(total)}`,
    savedLine: (inserted: number, duplicates: number) =>
      `${num(inserted)} ${plural(inserted, "spremljena", "spremljene", "spremljeno")} u tvoju biblioteku${
        duplicates ? `, ${num(duplicates)} ${plural(duplicates, "već je bila", "već su bile", "već je bilo")} ondje` : ""
      }.`,
    saveError: "Neke ruke nije bilo moguće spremiti. Tvoja pretvorena datoteka i dalje je potpuna.",
    downloadAll: "Preuzmi sve",
    downloadAllName: (stamp: string, count: number) => `pokerconverter ${stamp} - ${count} ${ruka(count)}.txt`,
    fileSuffix: "pretvoreno",
    fileStemFallback: "ruke",
    writeRefused: "Baza podataka odbila je zapis.",
    retrySave: "Pokušaj ponovno spremiti",
    statHands: (count: number) => ruka(count),
    statFiles: (total: number) => `od ${num(total)} ${plural(total, "datoteke", "datoteke", "datoteka")}`,
    statSaved: "spremljeno",
    statDuplicates: "već u tvojoj biblioteci",
    statFailed: "nije pretvoreno",
    sitesDetected: "Prepoznate sobe",
    handsChip: (count: number) => `${num(count)} ${ruka(count)}`,
    skippedChip: (count: number) =>
      `${num(count)} ${plural(count, "preskočena", "preskočene", "preskočeno")}`,
    stopped: "zaustavljeno",
    download: "Preuzmi",
    detail: "Detalji",
    hideDetail: "Sakrij detalje",
    moreFailures: (count: number) => `Još ${num(count)} — pogledaj panel ispod.`,
    convertedHands: "Pretvorene ruke",
    showMore: (left: number) =>
      `Prikaži više — ${plural(left, "preostala je", "preostale su", "preostalo je")} ${num(left)}`,
    players: (count: number) => `${num(count)} ${plural(count, "igrač", "igrača", "igrača")}`,
    pot: (amount: string) => `pot ${amount}`,
    preview: "Pregled",
    replay: "Odigraj",
  },

  failures: {
    heading: (count: number, refusedOnly: boolean) =>
      `${num(count)} ${plural(count, "ruka koju", "ruke koje", "ruku koje")} ${refusedOnly ? "" : "još "}nismo uspjeli pretvoriti`,
    downloadForCopy: "Preuzmi ih ispod za svoju kopiju.",
    notKeptNoDb: "Ništa nije napustilo tvoj preglednik — ova verzija nema bazu podataka.",
    notKeptSavingOff: "Ništa nije napustilo tvoj preglednik; spremanje je isključeno.",
    keeping: "Spremamo kopiju kako bismo mogli napisati konverter…",
    kept: (created: number, updated: number) => {
      const fresh = `${num(created)} ${plural(created, "novu ruku", "nove ruke", "novih ruku")}`;
      if (created > 0 && updated > 0) {
        return `Zadržali smo ${fresh}, a ${num(updated)} smo već imali. Iz tog reda pišemo sljedeće konvertere.`;
      }
      if (created > 0) {
        return `Zadržali smo ${fresh}. Iz tog reda pišemo sljedeće konvertere.`;
      }
      if (updated > 0) {
        return updated === 1
          ? "Ovu smo već imali — tvoje učitavanje pomaknulo ju je naprijed u redu."
          : `Već smo imali svih ${num(updated)} — tvoje učitavanje pomaknulo ih je naprijed u redu.`;
      }
      return "Nismo uspjeli zadržati kopiju ovih ruku, pa ih preuzmi ako želiš da ih vidimo.";
    },
    notSupported: "Nije podržano",
    showHand: "Prikaži ruku",
    hideHand: "Sakrij ruku",
    copied: "Kopirano",
    copySample: "Kopiraj primjer",
    downloadCount: (count: number) => `Preuzmi ${num(count)}`,
    moreLikeThis: (count: number) =>
      `Još ${num(count)} ${plural(count, "takva", "takve", "takvih")} — preuzmi grupu da ih vidiš sve.`,
    fileName: (site: string, reason: string) => `nepretvoreno - ${site} - ${reason}.txt`,
    refusals: {
      "wpt-global":
        "Ovo je ruka s WPT Globala. WPT Global je u lipnju 2026. uklonio izvoz hand historyja iz svog klijenta, pa se ovakve datoteke više ne mogu dobiti i za njih ne dodajemo konverter. Tvoju datoteku i dalje možeš preuzeti ispod.",
      pppoker:
        "Ovo je ruka s PPPokera. PPPoker nema izvoz hand historyja — ovu datoteku nije napravio njegov klijent, pa je ne možemo pouzdano pretvoriti i za nju ne dodajemo konverter.",
    },
    stages: {
      detect: "Nepodržani format",
      split: "Ne može se razdvojiti na ruke",
      parse: "Ne može se pročitati",
      validate: "Nije prošlo naše provjere",
      serialize: "Ne može se zapisati",
    },
    reasons: {
      "unknown-site": "Ovaj format hand historyja još ne prepoznajemo.",
      "no-hands": "Prepoznali smo format, ali u tekstu nismo našli nijednu cijelu ruku.",
      "split-failed": "Ovu datoteku nismo uspjeli razdvojiti na pojedinačne ruke.",
      "parser-error": "Naš konverter naišao je u ovoj ruci na nešto što nije očekivao.",
      "tournament-in-cash-mode": "Turnirska ruka, preskočena jer je konverter bio postavljen samo na cash igre.",
      "bomb-pot": "Bomb pot, preskočen na zahtjev.",
      "chip-mismatch": "Žetoni u ovoj ruci ne zbrajaju se, pa bi pretvaranje dalo pogrešne brojeve.",
      "duplicate-card": "Ista karta pojavljuje se dvaput u ovoj ruci.",
      "bb-only-walk": "Svi su foldali do big blinda, pa nema ruke za replay.",
      "uncalled-exceeds-commitment": "Vraćeni nepozvani bet veći je od onoga što je stvarno uloženo.",
      "normalized-unparseable": "Ruka je ispravno pročišćena, ali je naš čitač i dalje ne razumije.",
      "invalid-hand": "Pretvorena ruka nije prošla naše provjere dosljednosti.",
    },
  },

  preview: {
    dialogLabel: (handId: string) => `Ruka ${handId}`,
    heading: (handId: string) => `Ruka #${handId}`,
    close: "Zatvori",
    openInReplayer: "Otvori u replayeru",
    copied: "Kopirano",
    copyText: "Kopiraj tekst",
    download: "Preuzmi",
    fileName: (handId: string) => `ruka-${handId}.txt`,
  },

  library: {
    heading: "Povijest ruku",
    noDatabase: "Baza podataka nije postavljena.",
    privateToAccount: "Vidljivo samo tvom računu.",
    count: (count: number) => `${num(count)} ${ruka(count)}`,
    loadFailed: "Učitavanje ruku nije uspjelo.",
    parseFailed: "Ovu ruku nije moguće pročitati.",
    loadHandFailed: "Učitavanje ove ruke nije uspjelo.",
    fromConverter: "Iz konvertera — nije spremljeno u tvoju biblioteku.",
    signInPrompt: "Prijavi se da vidiš ruke koje si spremio/la.",
    signInReason: "Prijavi se da otvoriš svoju biblioteku ruku.",
    signIn: "Prijavi se",
    previous: "← Prethodna",
    next: "Sljedeća →",
    page: (page: number, pages: number) => `Stranica ${num(page)} od ${num(pages)}`,
  },

  list: {
    loading: "Učitavam ruke…",
    empty:
      "Nijedna ruka ne odgovara ovim filterima. Pretvori svoje hand historyje u konverteru ili učitaj pojedinačnu ruku.",
    columns: {
      time: "Vrijeme",
      hero: "Hero",
      board: "Board",
      table: "Stol",
      pot: "Pot",
      heroNet: "Hero +/−",
    },
    standardFormat: "Standardni format",
    preflop: "preflop",
    anon: "ANON",
    anonTitle:
      "Ova soba označava svako mjesto pozicijom umjesto imenom igrača, pa ovu ruku filter po imenu ne može pronaći. Filtriraj po poziciji.",
    showdown: "SD",
    replay: "Odigraj",
  },

  filters: {
    board: "Board",
    boardPlaceholder: "npr. Ah Kd 2c  ili  AhKd",
    boardMatches: "Ruke čiji board sadrži",
    boardHint: "Svaka karta koju upišeš mora biti na boardu",
    heroCards: "Heroove karte",
    heroCardsPlaceholder: "npr. AhKs  ili  AKs  ili  TT",
    handClass: (classes: string) => `Klasa ruke: ${classes}`,
    exactly: "Točno",
    heroCardsHint: "Točne karte (AhKs) ili klasa ruke (AKs, AKo, AK, TT)",
    search: "Traži",
    searching: "Tražim…",
    reset: "Poništi",
    moreFilters: "Više filtera",
    fewerFilters: "Manje filtera",
    quick: "Brzo:",
    showdownOnly: "Samo showdown",
    heroWon: "Hero u plusu",
    biggestPots: "Najveći potovi",
    heroPosition: "Pozicija heroja",
    winnerPosition: "Pozicija pobjednika",
    winnerHint:
      "Tko je uzeo pot, po mjestu za stolom. Samo tako to možeš pitati za sobu koja ti ne daje imena igrača.",
    clear: "Očisti",
    player: "Igrač za stolom",
    playerPlaceholder: "točan nadimak",
    playerHint: "Točan nadimak, onako kako ga je soba zapisala.",
    playerHintLossy: (count: number) =>
      `Točan nadimak. ${num(count)} ${ruka(count)} iz soba koje mjesta označavaju pozicijom ne ${plural(count, "može", "mogu", "može")} se pronaći po imenu.`,
    site: "Soba",
    everyRoom: "Sve sobe",
    siteOption: (name: string, count: number) => `${name} (${num(count)})`,
    game: "Igra",
    gameAny: "Cash i turniri",
    gameCash: "Samo cash",
    gameTournament: "Samo turniri",
    table: "Stol",
    tablePlaceholder: "npr. NLHPurple",
    minPot: "Min. pot",
    minPotChips: "U žetonima",
    minPotCurrency: "U valuti stola",
    from: "Od",
    to: "Do",
    sortBy: "Poredaj po",
    sort: {
      played_desc: "Najnovije prvo",
      played_asc: "Najstarije prvo",
      pot_desc: "Najveći pot",
      profit_desc: "Najveći dobitak heroja",
      profit_asc: "Najveći gubitak heroja",
    },
    excluded: (count: number) => `Filter po imenu isključuje ${num(count)} ${plural(count, "ruku", "ruke", "ruku")}.`,
    positionalNote:
      "Ova soba označava svako mjesto pozicijom u odnosu na button, a button se pomiče svaku ruku, pa imena villaina nisu stvarni ljudi. Filtriraj po poziciji.",
  },
};

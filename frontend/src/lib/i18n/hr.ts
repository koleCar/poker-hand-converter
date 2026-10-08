/**
 * Hrvatski. Same shape as `en.ts`, checked by `Dict`: a missing or extra key,
 * or a function with the wrong arguments, does not compile.
 *
 * Poker vocabulary stays in the form Croatian players actually use — flop,
 * turn, river, showdown, bet, raise, all-in, VPIP — rather than a coinage
 * nobody at a table would recognise. Plurals take the three Croatian forms
 * (`plural()` below): 1 komentar, 2 komentara, 5 komentara; 1 glas, 2 glasa,
 * 5 glasova.
 */

import { analysisHr } from "./ns/analysis.hr";
import { chromeHr } from "./ns/chrome.hr";
import { converterHr } from "./ns/converter.hr";
import { courseHr } from "./ns/course.hr";
import { learnHr } from "./ns/learn.hr";
import { manualHr } from "./ns/manual.hr";
import { replayerHr } from "./ns/replayer.hr";
import { statsHr } from "./ns/stats.hr";
import type { Dict } from "./types";

import { plural } from "./plural";

export { plural };

const num = (value: number) => value.toLocaleString("hr-HR");

export const hr: Dict = {
  stats: statsHr,
  analysis: analysisHr,
  learn: learnHr,
  course: courseHr,
  replayer: replayerHr,
  converter: converterHr,
  manual: manualHr,
  chrome: chromeHr,

  brand: {
    name: "Rail",
    tagline: "Pokerske ruke, odigrane i prokomentirane",
  },

  meta: {
    home: {
      title: "Rail — replayer pokerskih ruku i konverter hand historyja",
      description:
        "Pregledaj bilo koju pokersku ruku akciju po akciju i podijeli je jednim linkom. Pretvori hand historyje iz bilo koje sobe u standardni format za Holdem Manager. Besplatno, bez računa.",
    },
    convert: {
      title: "Konverter hand historyja — WePlay, PokerStars, GGPoker | Rail",
      description:
        "Pretvori hand historyje iz bilo koje pokerske sobe u standardni format koji uvoze Holdem Manager i PokerTracker. Besplatno, u pregledniku, ništa se ne šalje.",
    },
    convertManual: {
      title: "Ručni unos pokerske ruke — izrada hand historyja | Rail",
      description:
        "Složi pokersku ruku ručno: sjedala, stackovi, blindovi, svaka akcija i showdown. Odigraj je, preuzmi kao hand history ili spremi. Besplatno, u pregledniku.",
    },
    library: {
      title: "Povijest ruku | Rail",
      description: "Pregledaj, filtriraj i odigraj svaku spremljenu ruku, i podijeli je jednim linkom.",
    },
    stats: {
      title: "Statistika | Rail",
      description:
        "VPIP, PFR, 3-bet, continuation betovi i graf dobitka sa showdownom i bez njega, za svaku spremljenu ruku.",
    },
    analysis: {
      title: "Analiza ruku | Rail",
      description:
        "Svaka odluka u tvojim spremljenim rukama: board, tvoja ruka, cijena i provjere koje vrijede bez obzira na strategiju.",
    },
    analysisReports: {
      title: "Izvještaji — tvoje frekvencije prema referenci | Rail",
      description: "Tvoje preflop frekvencije u svakoj situaciji koju chartovi pokrivaju, uz frekvencije reference i ruke u kojima si od nje odstupio.",
    },
    analysisLeaks: {
      title: "Leakovi — situacije koje te najviše koštaju | Rail",
      description: "Tvoje ocijenjene odluke grupirane u situacije i poredane po EV-u koji su te koštale u odnosu na referencu, s rukama iza svake.",
    },
    analysisTrain: {
      title: "Vježbaj — preflop, river i tvoje greške | Rail",
      description:
        "Vježbaj preflop i river situacije protiv iste reference po kojoj se ocjenjuju tvoje ruke i ponavljaj vlastite greške dok ne budu točne.",
    },
    analysisPlan: {
      title: "Plan učenja — na čemu raditi ovaj tjedan | Rail",
      description:
        "Fokus ovog tjedna iz tvojih leakova: pojmovi za čitanje, situacije za trener, tvoje vježbe i vlastite ruke za pregled, s napretkom iz tjedna u tjedan.",
    },
    analysisProgress: {
      title: "Napredak — tvoj score kroz vrijeme | Rail",
      description: "Score analize i izgubljeni EV na 100 ruku po tjednu, mjesecu ili sesiji, po streetu, poziciji i vrsti pota.",
    },
    analysisHand: {
      title: "Analiza ruke | Rail",
      description: "Jedna tvoja ruka, odluku po odluku, u replayeru.",
    },
    learn: {
      title: "Nauči pokersku strategiju: pot odds, rasponi, MDF, SPR i više | Rail",
      description:
        "Besplatno objašnjeni pokerski pojmovi s razrađenim primjerima i interaktivnim kalkulatorima: pot odds, realizacija equityja, rasponi, tekstura boarda, MDF, SPR, veličina beta, 3-betovi i više.",
    },
    learnConcept: (title: string) => `${title} — pokerski pojmovi | Rail`,
    course: {
      title: "Nauči poker: tečaj cash igre s vježbama koje ocjenjuje solver | Rail",
      description:
        "Besplatan tečaj cash pokera, od pot oddsa i rangeova do preflopa i 3-bet potova: kratke lekcije, provjere u kojima prvo predviđaš pa vidiš odgovor, i vježbe koje generiraju i ocjenjuju Railovi vlastiti chartovi i solver.",
    },
    lesson: (title: string) => `${title} — Učenje | Rail`,
    learnReview: {
      title: "Ponavljanje — pitanja koja si promašio | Rail",
      description: "Pitanja iz lekcija koja si promašio, ponovno po rasporedu razmaknutog ponavljanja.",
    },
    charts: {
      title: "Preflop chartovi: 6-max i 9-max cash, mix i EV svake ruke | Rail",
      description:
        "Railovi vlastiti preflop chartovi za 6-max (40-200 bb) i 9-max (100-200 bb) cash: otvaranja, 3-betovi, 4-betovi, squeezeovi i blind protiv blinda, s frekvencijom i EV-om svake akcije za svih 169 ruku.",
    },
    notFound: {
      title: "Stranica nije pronađena | Rail",
      description: "Ova adresa ne odgovara ničemu na Railu.",
    },
    sharedHand: {
      fallbackTitle: "Podijeljena pokerska ruka | Rail",
      fallbackDescription: "Pregledaj podijeljenu pokersku ruku akciju po akciju, besplatno i bez računa, na Railu.",
    },
  },

  language: {
    label: "Jezik",
    hint: "Rail pamti tvoj izbor u ovom pregledniku.",
  },

  nav: {
    sections: "Odjeljci",
    forum: "Forum",
    convert: "Učitaj ruku",
    library: "Povijest ruku",
    stats: "Statistika",
    analysis: "Analiza",
    learn: "Učenje",
  },

  home: {
    heading: "Feed stiže uskoro",
    body: "Ruke o kojima se vrijedi raspraviti, objavljene i odigrane u threadu. Dok se ne otvori, ono što Rail već radi udaljeno je jedan klik.",
    convertCta: "Pretvori hand history",
    libraryCta: "Otvori svoju biblioteku",
    note: "Pretvaranje, pregled, preuzimanje i replay ne trebaju račun.",
  },

  convert: {
    privacy: "Ništa se ne šalje. Hand historyji se pretvaraju u ovoj kartici i nikad je ne napuštaju.",
  },

  notFound: {
    heading: "Stranica nije pronađena",
    body: "Ova adresa ne odgovara ničemu na Railu.",
    convertCta: "Idi na konverter",
    libraryCta: "Otvori replayer",
  },

  share: {
    ownHandsLink: "Odigraj svoje ruke",
    openAppCta: "Otvori aplikaciju",
    tryFreeCta: "Isprobaj besplatno",
    footerBlurb: "— pretvori hand historyje iz bilo koje sobe i odigraj bilo koju ruku u pregledniku.",
    ctaHeading: "Odigraj i pretvori svoje ruke",
    ctaBody:
      "Ubaci hand history iz bilo koje pokerske sobe i dobit ćeš replay poput ovog, spreman za dijeljenje. Besplatno, u pregledniku, bez računa.",
    ctaReplayer: "Otvori replayer",
    ctaConvert: "Pretvori hand history",
    loadingLabel: "Učitavanje ruke",
    sharedAt: (when: string) => `Podijeljeno ${when}`,
    views: (count: number) => `${num(count)} ${plural(count, "pregled", "pregleda", "pregleda")}`,
    problems: {
      notFound: {
        title: "Ovaj link na ruku ne postoji",
        body: "Možda je u linku tipfeler, ili ruka nikad nije podijeljena. Provjeri adresu i pokušaj ponovno.",
      },
      gone: {
        title: "Ova ruka više nije dostupna",
        body: "Osoba koja ju je podijelila obrisala je ruku, ili je link istekao.",
      },
      unparseable: {
        title: "Ovu ruku nije moguće odigrati",
        body: "Spremljeni hand history je oštećen ili u formatu koji još ne znamo pročitati.",
      },
      unconfigured: {
        title: "Podijeljene ruke trenutno nisu dostupne",
        body: "Ova instalacija nema bazu podataka, pa se podijeljeni linkovi ne mogu otvoriti. Konverter i učitavanje i dalje rade.",
      },
      error: {
        title: "Nešto je pošlo po zlu pri učitavanju ove ruke",
      },
    },
    problemReplayCta: "Odigraj svoju ruku",
    problemHomeCta: "Idi na Rail",
  },

  shell: {
    offlineBanner: "Baza podataka nije postavljena — biblioteka i dijeljenje su isključeni. Pretvaranje i dalje radi.",
  },

  auth: {
    callbackFailed: "Taj link za prijavu nije uspio. Zatraži novi i pokušaj ponovno.",
  },

  account: {
    menuProfile: "Tvoj profil",
    menuSettings: "Postavke",
  },

  profile: {
    metaTitle: (username: string) => `${username} | Rail`,
    metaDescription: (username: string) => `${username} na Railu — pokerske ruke, odigrane i prokomentirane.`,
    joined: (date: string) => `Pridružen/a ${date}`,
    karma: (count: number) => `${num(count)} karme`,
    yours: "Ovo je tvoj profil.",
    editCta: "Promijeni korisničko ime",
    emptyHeading: "Još ništa objavljeno",
    emptyBody: "Ruke koje ovaj igrač objavi bit će navedene ovdje.",
    publishedHeading: "Objavljene ruke",
    untitledHand: (stakes: string) => `Ruka ${stakes}`,
    unavailable: {
      heading: "Profili trenutno nisu dostupni",
      body: "Ova instalacija nema bazu podataka, pa se profili ne mogu prikazati.",
    },
    homeCta: "Idi na Rail",
  },

  handSummary: {
    seats: "Mjesta",
    seat: "Mjesto",
    player: "Igrač",
    position: "Pozicija",
    stack: "Stack",
    board: "Board",
    noFlop: "Flop nije podijeljen.",
    action: "Akcija",
    streets: {
      preflop: "Preflop",
      flop: "Flop",
      turn: "Turn",
      river: "River",
      showdown: "Showdown",
    },
    result: "Rezultat",
    revealResult: "Pokaži kako je ruka završila",
    pot: (amount: string) => `Pot ${amount}`,
    net: (player: string, amount: string) => `${player} ${amount}`,
    handText: "Hand history (tekst)",
    hero: "Hero",
  },

  published: {
    metaTitleFallback: "Pokerska ruka | Rail",
    headline: (stakes: string, game: string, hero: string | null) =>
      hero ? `${stakes} ${game} — hero ${hero}` : `${stakes} ${game}`,
    facts: {
      site: (name: string) => name,
      handed: (count: number) => `${count} za stolom`,
      playedOn: (date: string) => `odigrano ${date}`,
      by: "objavio/la",
      anonymous: "obrisani račun",
    },
    modeNote: {
      pseudonyms: "Igrač koji je objavio ruku zamijenio je imena protivnika s Villain1, Villain2…",
      positions: "Igrač koji je objavio ruku zamijenio je imena protivnika njihovim pozicijama za stolom.",
      "as-imported": "Imena su prikazana onako kako ih je soba ispisala, po izboru igrača koji je objavio ruku.",
    },
    replayHeading: "Replay",
    poll: {
      heading: "Ova ruka je anketa",
      body: "Autor pita što bi ti odigrao/la u jednoj od njegovih odluka. Odgovori i otvorit će se cijela ruka.",
      cta: "Odgovori na anketu",
    },
    gone: {
      deleted: {
        heading: "Ovu ruku uklonila je osoba koja ju je objavila",
        body: "Više nije dostupna.",
      },
      removed: {
        heading: "Ovu ruku uklonio je moderator",
        body: "Više nije dostupna.",
      },
      unavailable: {
        heading: "Objavljene ruke trenutno nisu dostupne",
        body: "Ova instalacija nema bazu podataka.",
      },
    },
    homeCta: "Idi na Rail",
    convertCta: "Odigraj svoje ruke",
  },

  og: {
    poll: "Anketa",
    pollTitle: "Što bi ti odigrao/la?",
    pollFacts: "Odgovori da vidiš ostatak ruke",
    handEyebrow: "Ruka",
    handFallback: "Pokerska ruka na Railu",
    forumEyebrow: "Forum",
    threadFallback: "Thread na Railu",
    handed: (count: number) => `${count} za stolom`,
    hero: (position: string) => `hero ${position}`,
    by: (username: string) => `autor ${username}`,
    comments: (count: number) => `${count} ${plural(count, "komentar", "komentara", "komentara")}`,
  },

  embed: {
    title: "Replayer ruke | Rail",
    credit: "Odigraj na Railu",
    gone: "Ova ruka više nije dostupna.",
    button: "Ugradi",
    heading: "Ugradi ovu ruku",
    hint: "Zalijepi ovo tamo gdje ruka treba biti — u forumski post, blog ili dokumentaciju. Prilagodi se širini koju dobije.",
    copy: "Kopiraj kod",
    copied: "Kopirano",
  },

  forum: {
    metaHomeTitle: "Rail — pokerske ruke, odigrane i prokomentirane",
    metaHomeDescription:
      "Pokerske ruke koje objavljuju oni koji su ih odigrali, s replayom akciju po akciju i raspravom u threadu. Besplatno, i za čitanje ne treba račun.",
    metaBoardTitle: (name: string) => `${name} — pokerske ruke i strategija | Rail`,
    metaBoardDescription: (name: string, description: string | null) =>
      description ?? `${name}: ruke i rasprava na Railu.`,
    allBoards: "Svi boardovi",
    sorts: { hot: "Popularno", new: "Novo", top: "Najbolje" },
    newPost: "Novi post",
    search: "Traži",
    searchPlaceholder: "Traži postove i komentare",
    empty: "Ovdje još nema ničega. Objavi prvu ruku.",
    next: "Stariji postovi",
    first: "Natrag na prvu stranicu",
    commentCount: (count: number) => `${count} ${plural(count, "komentar", "komentara", "komentara")}`,
    points: (score: number) => `${score} ${plural(score, "bod", "boda", "bodova")}`,
    by: "autor",
    in: "u",
    deletedAuthor: "[obrisano]",
    edited: "uređeno",
    pinned: "Prikvačeno",
    locked: "Zaključano",
    upvote: "Glasaj za",
    downvote: "Glasaj protiv",
    anchorAfter: (where: string, what: string) => `${where}, nakon: ${what}`,
    handBadge: "Ruka",
    postDate: (date: string) => date,

    poll: {
      badge: (votes: number) => `Anketa · ${votes} ${plural(votes, "odgovor", "odgovora", "odgovora")}`,
      heading: "Što bi ti odigrao/la?",
      intro: (votes: number) =>
        votes === 0
          ? "Još nitko nije odgovorio. Odgovori da vidiš ostatak ruke i raspravu."
          : `${votes} ${plural(votes, "osoba je odgovorila", "osobe su odgovorile", "osoba je odgovorilo")}. Odgovori da vidiš ostatak ruke, kako su glasali i raspravu.`,
      cardsHidden: "Autor je sakrio svoje karte: ovdje je pitanje o rangeu.",
      size: "Veličina (dio pota)",
      sizeNone: "Bez veličine",
      vote: "Odgovori",
      voting: "Šaljem…",
      signIn: "Prijavi se za odgovor",
      results: "Kako su ljudi odgovorili",
      hero: "što se dogodilo",
      votes: (count: number) => `${count} ${plural(count, "glas", "glasa", "glasova")}`,
      median: (pct: number) => `medijan ${pct}% pota`,
      yours: "tvoj odgovor",
      authorNote: "Tvoja anketa. Čitatelji vide ruku zaustavljenu na tvojoj odluci dok ne odgovore; ti vidiš sve.",
      handGone: "Ruka iza ove ankete više nije objavljena.",
      discussionLocked: "Rasprava se otvara kad odgovoriš.",
    },
    post: {
      replayHeading: "Replay",
      commentOnSpot: "Komentiraj ovaj trenutak",
      spotAttached: (label: string) => `Komentiraš: ${label}`,
      clearSpot: "Ukloni",
      edit: "Uredi",
      delete: "Obriši",
      deleteConfirm: "Obrisati ovaj post? Thread ostaje čitljiv, ali tvoj post će pisati da je obrisan.",
      save: "Spremi",
      cancel: "Odustani",
      removed: {
        heading: "Ovaj post uklonio je moderator",
        body: "Više nije dostupan.",
      },
      deleted: {
        heading: "Ovaj post obrisao je autor",
        body: "Više nije dostupan.",
      },
      unavailable: {
        heading: "Forum trenutno nije dostupan",
        body: "Ova instalacija nema bazu podataka.",
      },
      viewerOnly:
        "Ovaj post vidite samo ti i moderatori: zadržan je na pregledu ili je uklonjen. Svi ostali dobivaju „nije pronađeno”.",
      backToBoard: (name: string) => `Natrag na ${name}`,
    },

    comments: {
      heading: (count: number) => `${count} ${plural(count, "komentar", "komentara", "komentara")}`,
      sort: { best: "Najbolji", new: "Najnoviji", top: "Najviše glasova" },
      placeholder: "Pridruži se raspravi",
      replyPlaceholder: "Napiši odgovor",
      submit: "Komentiraj",
      submitting: "Objavljujem…",
      reply: "Odgovori",
      delete: "Obriši",
      deleted: "[obrisano]",
      removed: "[uklonjeno]",
      signIn: "Prijavi se za komentiranje.",
      locked: "Ovaj thread je zaključan.",
      permalink: "Link",
      anchorChip: (label: string) => `kod ${label}`,
    },

    submit: {
      metaTitle: "Novi post | Rail",
      heading: "Novi post",
      board: "Board",
      title: "Naslov",
      titlePlaceholder: "Koje je pitanje?",
      body: "Tekst",
      bodyPlaceholder: "Što se dogodilo, što si mislio/la, u što nisi siguran/na.",
      hand: "Ruka",
      handAttached: (label: string) => `Priloženo: ${label}`,
      handHint: "Za post s rukom prvo je objavi iz svoje biblioteke — otvorit će se ovdje s priloženom rukom.",
      submit: "Objavi",
      submitting: "Objavljujem…",
      signIn: "Prijavi se za objavu.",
      poll: {
        toggle: "Pitaj čitatelje što bi oni odigrali",
        toggleHint:
          "Čitatelji vide ruku do tvoje odluke, glasaju, i tek onda vide ostatak — i komentare. Ruka ostaje skrivena svugdje drugdje dok ne odgovore.",
        spot: "Zaustavi na",
        spotLabel: (street: string, facing: boolean, did: string) =>
          `${street[0].toUpperCase()}${street.slice(1)}, ${facing ? "ispred tebe je bet" : "nema beta ispred tebe"} — ti si: ${did.toLowerCase()}`,
        options: "Ponuđeni odgovori",
        optionLocked: "što si odigrao/la",
        hideCards: "Sakrij moje karte (pitanje o rangeu, ne o ruci)",
        noSpots: "U ovoj ruci nema tvoje odluke o kojoj bi se moglo pitati.",
      },
    },

    searchPage: {
      metaTitle: (query: string) => (query ? `„${query}” — pretraga | Rail` : "Pretraga | Rail"),
      heading: "Pretraga",
      results: (count: number, query: string) =>
        `${count} ${plural(count, "rezultat", "rezultata", "rezultata")} za „${query}”`,
      none: (query: string) => `Ništa ne odgovara upitu „${query}”.`,
      inPost: "u",
      commentOn: "Komentar na",
      button: "Traži",
    },
  },

  social: {
    bell: (count: number) =>
      count ? `Obavijesti, ${count} ${plural(count, "nepročitana", "nepročitane", "nepročitanih")}` : "Obavijesti",
    notificationsTitle: "Obavijesti | Rail",
    notificationsHeading: "Obavijesti",
    markAllRead: "Označi sve kao pročitano",
    noNotifications: "Još ništa. Ovdje će se pojaviti odgovori tebi i spominjanja tvog imena.",
    kinds: {
      comment_reply: (actor: string) => `${actor} je odgovorio/la na tvoj komentar`,
      post_reply: (actor: string) => `${actor} je komentirao/la tvoj post`,
      mention: (actor: string) => `${actor} te spomenuo/la`,
      thread: (actor: string) => `${actor} je komentirao/la u threadu koji pratiš`,
    },
    someone: "Netko",
    savedTitle: "Spremljeno | Rail",
    savedHeading: "Spremljeni postovi",
    noSaved: "Ništa nije spremljeno. Klikni Spremi na bilo kojem postu da ga zadržiš ovdje.",
    save: "Spremi",
    saved: "Spremljeno",
    watch: "Prati thread",
    watching: "Pratiš",
    mute: "Utišaj",
    muted: "Utišano",
    unmute: "Ponovno uključi",
    signIn: "Prijavi se da vidiš svoje obavijesti.",
    newComments: (count: number) => `${count} ${plural(count, "novi komentar", "nova komentara", "novih komentara")} — prikaži`,
    menuSaved: "Spremljeni postovi",
    menuNotifications: "Obavijesti",
  },

  moderation: {
    report: "Prijavi",
    reportHeading: "Prijavi ovo",
    reasons: {
      spam: "Spam ili reklama",
      harassment: "Uznemiravanje ili zlostavljanje",
      cheating: "Varanje, dogovaranje ili ghosting",
      "off-topic": "Izvan teme",
      "hh-takedown": "Moj hand history — molim uklonite ga",
      other: "Nešto drugo",
    },
    detailsLabel: "Što bi moderator trebao znati (neobavezno)",
    submitReport: "Pošalji prijavu",
    reported: "Hvala — moderator će to pogledati.",
    alreadyReported: "Ovo si već prijavio/la. Moderator će to pogledati.",
    cancel: "Odustani",
    signIn: "Prijavi se da bi nešto prijavio/la.",
    tools: "Moderacija",
    remove: "Ukloni",
    restore: "Vrati",
    approve: "Odobri",
    lock: "Zaključaj",
    unlock: "Otključaj",
    pin: "Prikvači",
    unpin: "Otkvači",
    editTitle: "Uredi naslov",
    save: "Spremi",
    reasonPrompt: "Razlog (ide u zapis moderacije)",
    edited: "uređeno",
    revisions: "Povijest izmjena",
    revisionAt: (date: string) => `Prije izmjene od ${date}`,
    modTitle: "Moderacija | Rail",
    modHeading: "Moderacija",
    notModerator: "Ova stranica je za moderatore.",
    tabs: { reports: "Prijave", spam: "Spam", users: "Računi", admin: "Admin" },
    noReports: "Nema otvorenih prijava.",
    noSpam: "Ništa nije zadržano kao spam.",
    reportedBy: (who: string) => `prijavio/la ${who}`,
    open: "Otvori",
    dismiss: "Odbaci",
    actioned: "Označi riješenim",
    lookup: "Potraži",
    usernamePlaceholder: "korisničko ime",
    ban: "Zabrani",
    banDays: "Dana (prazno = trajno, samo admin)",
    unban: "Ukini zabranu",
    shadowban: "Shadowban",
    unshadowban: "Ukini shadowban",
    overlap: "Glasa usklađeno s",
    noOverlap: "Nijedan račun ne glasa usklađeno s ovim.",
    setRole: "Postavi ulogu",
    createBoard: "Napravi board",
    boardSlug: "slug",
    boardName: "Naziv",
    boardMod: "Moderator boarda",
    grant: "Dodijeli",
    revoke: "Oduzmi",
    done: "Gotovo.",
    takedownTitle: "Uklanjanje hand historyja | Rail",
    takedownHeading: "Uklanjanje hand historyja",
    takedownBody: [
      "Ako ruka objavljena na Railu uključuje tebe ili tvoju pokersku sobu i želiš da se ukloni, prijavi je s razlogom „Moj hand history — molim uklonite ga”. Za prijavu treba račun; to traje minutu i traži samo e-mail adresu.",
      "Moderator odgovara u roku od 48 sati. Ruka uklonjena na ovaj način nestaje sa svoje stranice, iz svakog threada i iz sitemapa; uklanjanje se bilježi u zapisu moderacije.",
      "Objavljene ruke nikad ne sadrže izvorni tekst sobe, naziv stola, broj ruke ni točno vrijeme, a imena protivnika se zamjenjuju po defaultu.",
    ],
    menuMod: "Moderacija",
    roles: { member: "član", moderator: "moderator", admin: "admin" },
    userLine: (role: string, karma: number) => ` · ${role} · ${karma} karme`,
    facts: {
      joined: (date: string) => `pridružen/a ${date}`,
      posts: (count: number) => `· ${count} ${plural(count, "post", "posta", "postova")}`,
      comments: (count: number) => `· ${count} ${plural(count, "komentar", "komentara", "komentara")}`,
      reports: (count: number) => `· ${count} ${plural(count, "prijava", "prijave", "prijava")}`,
      bannedUntil: (date: string) => `· zabranjen/a do ${date}`,
      shadowbanned: "· shadowban",
    },
  },

  publish: {
    button: "Objavi ruku",
    publishedButton: "Objavljeno — pogledaj",
    heading: "Objavi ovu ruku",
    lead: "Objavljuješ ruku koju si odigrao/la. Imena protivnika se po defaultu zamjenjuju.",
    titleLabel: "Naslov (neobavezno)",
    titlePlaceholder: "Koje je pitanje?",
    modeLabel: "Imena",
    modes: {
      pseudonyms: {
        label: "Villain1, Villain2… (preporučeno)",
        hint: "Ti si Hero; protivnici dobivaju numerirana imena.",
      },
      positions: {
        label: "Pozicije za stolom",
        hint: "Ti si Hero; protivnici su prikazani po poziciji — BTN, SB, BB…",
      },
      "as-imported": {
        label: "Imena kako ih je soba ispisala",
        hint: "Svi za stolom, uključujući tebe, prikazani su pravim imenom.",
      },
    },
    asImportedWarning:
      "Većina pokerskih soba zabranjuje objavljivanje imena drugih igrača. Odaberi ovo samo ako su se svi za stolom složili.",
    asImportedConfirm: "Razumijem, prikaži prava imena",
    alwaysRemoved: "U svakom načinu uklanjaju se izvorni tekst sobe, naziv stola, broj ruke i točno vrijeme.",
    submit: "Objavi",
    submitting: "Objavljujem…",
    cancel: "Odustani",
    done: "Objavljeno. Svatko s linkom — i tražilice — može je vidjeti.",
    already: "Ovu ruku si već objavio/la. Evo je.",
    view: "Otvori objavljenu ruku",
    discuss: "Pokreni thread o njoj",
    notStored: "Prvo spremi ruku u svoju biblioteku — objaviti se mogu samo spremljene ruke.",
    signIn: "Prijavi se za objavu ruke.",
  },

  settings: {
    metaTitle: "Postavke | Rail",
    metaDescription: "Tvoje korisničko ime i račun na Railu.",
    heading: "Postavke",
    signedOut: "Prijavi se da promijeniš korisničko ime i postavke računa.",
    signInCta: "Prijava",
    loading: "Učitavam tvoj račun…",
    unavailable: "Postavke računa još nisu postavljene na ovoj bazi. Sve ostalo i dalje radi.",
    loadFailed: "Tvoj račun nije se mogao učitati. Osvježi stranicu i pokušaj ponovno.",

    username: {
      heading: "Korisničko ime",
      label: "Korisničko ime",
      hint: "3–24 znaka: slova, brojke i podvlake. To je tvoje javno ime i adresa tvog profila.",
      provisional: "Koristiš ime dobiveno pri registraciji. Odaberi svoje — prva promjena je besplatna.",
      rules:
        "Možeš ga mijenjati jednom u 30 dana. Staro ime ostaje rezervirano za tebe godinu dana, a linkovi na njega i dalje rade.",
      nextChange: (date: string) => `Sljedeća promjena moguća je ${date}.`,
      save: "Spremi korisničko ime",
      saving: "Spremam…",
      saved: (username: string) => `Spremljeno. Sada si ${username}.`,
      unchanged: "To je već tvoje korisničko ime.",
      tooShort: "Korisničko ime ima najmanje 3 znaka.",
      tooLong: "Korisničko ime ima najviše 24 znaka.",
      badCharacters: "Korisničko ime smije sadržavati samo slova, brojke i podvlake.",
      badStart: "Korisničko ime počinje slovom ili brojkom.",
      viewProfile: "Pogledaj svoj profil",
    },

    posting: {
      heading: "Objavljivanje",
      ok: "Tvoj račun može objavljivati.",
      blocked: "Tvoj račun još ne može objavljivati.",
      resend: "Ponovno pošalji e-mail za potvrdu",
      resending: "Šaljem…",
      resent: (email: string) => `Novi link za potvrdu stiže na ${email}.`,
    },
    password: {
      heading: "Lozinka",
      hint: "Najmanje šest znakova.",
      newLabel: "Nova lozinka",
      confirmLabel: "Ponovi novu lozinku",
      tooShort: "Upiši najmanje šest znakova.",
      mismatch: "Lozinke se ne podudaraju.",
      save: "Promijeni lozinku",
      saving: "Spremam…",
      saved: "Lozinka je promijenjena. Sljedeći put se prijavi novom.",
    },
  },
};

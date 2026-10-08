import { plural } from "../plural";

/**
 * Strings for the Learn tab (`/learn`, Learn L1), Croatian. Same shape as
 * `course.en.ts`. Poker words stay the ones Croatian players use (pot, bet,
 * call, fold, raise, check, equity, flop, turn, river, board, combo, open,
 * 3-bet, squeeze, limp); "range" is "raspon", as in the concept library. The
 * reader is addressed with "ti".
 */

const titles = {
  "how-rail-teaches": "Kako učiti uz Rail",
  "gto-mixing-and-simplifying": "Ravnoteža, iskorištavanje i zašto solver miješa",
  "reading-rail-reports": "Kako čitati svoju analizu i leakove",
  "variance-bankroll-and-tilt": "Varijanca, bankroll i prosudba odluka",
  "pot-odds": "Pot odds, korak po korak",
  "equity-and-outs": "Equity, outovi i brze procjene",
  "expected-value": "Očekivana vrijednost (EV)",
  "combos-and-card-removal": "Brojanje kombinacija",
  "bluffing-math-alpha-mdf": "Matematika blefa: alfa i MDF",
  "equity-realisation-and-implied-odds": "Realizacija equityja i implied odds",
  "thinking-in-ranges": "Od jedne ruke do raspona",
  "range-advantage": "Prednost raspona",
  "nut-advantage": "Prednost u nutsu",
  "board-texture": "Kako čitati flop",
  "who-the-next-card-helps": "Kome pomaže sljedeća karta",
  "range-narrowing": "Sužavanje raspona street po street",
  "positions-and-opening-ranges": "Pozicije i rasponi otvaranja, 6-max i full ring",
  "open-sizing": "Koliko otvoriti, online i uživo",
  "facing-an-open": "Pred openom: fold, call ili 3-bet",
  "three-betting": "Kako složiti raspon za 3-bet",
  "facing-3bets-and-4bets": "Kad te 3-betaju ili 4-betaju",
  "blind-play-and-bvb": "Obrana blindova i blind protiv blinda",
  "squeezes-and-multiway-preflop": "Squeezeovi i potovi s callerima",
  "limpers-and-isolation": "Igra protiv limpera",
  "cbet-why-and-when": "Zašto preflop raiser beta flop",
  "cbet-by-texture": "Betovi na flopu po vrsti boarda",
  "hand-classes-on-the-flop": "Koje ruke betaju, a koje checkaju",
  "oop-as-the-raiser": "Raise preflop, a zatim bez pozicije",
  "checking-back-and-delayed-cbets": "Check iza i bet kasnije",
  "facing-a-check-raise": "Kad ti raiseaju bet na flopu",
  "defending-vs-cbets": "Obrana od beta na flopu",
  "check-raising": "Check-raise na flopu",
  "floating-and-stabbing-ip": "Call u poziciji i preuzimanje pota",
  "probes-and-donk-bets": "Bet ispred raisera",
  "facing-turn-barrels": "Pred drugim barrelom",
  "bb-vs-btn-blueprint": "Big blind protiv buttona, od početka do kraja",
  "spr-and-commitment": "Omjer stacka i pota (SPR) i obveza",
  "cbetting-as-the-3bettor": "Bet na flopu kao igrač koji je 3-betao",
  "playing-3bp-as-the-caller": "Call na 3-bet i igra nakon toga",
  "range-splitting-ip-vs-checks-3bp": "U poziciji nakon checka u 3-bet potu: mali bet, veliki bet ili check",
  "four-bet-pots": "4-bet potovi",
  "turn-card-classes": "Vrste karata na turnu",
  "double-barreling": "Ponovni bet na turnu",
  "turn-sizing-and-overbets": "Veličine na turnu, overbetovi i check iza",
  "turn-after-flop-checks-through": "Turn nakon checkanog flopa",
  "river-polarisation": "River: value, blefovi i sredina",
  "thin-value": "Tanki value",
  "choosing-bluffs-blockers": "Kako odabrati blef na riveru",
  "bluff-catching": "Call do kraja s bluff-catcherom",
  "river-sizing": "Veličine beta na riveru",
  "facing-river-raises": "Kad ti raiseaju bet na riveru",
  "multiway-principles": "Što se mijenja s tri ili više igrača",
  "multiway-as-the-raiser": "Bet u dva protivnika",
  "multiway-defence": "Obrana i lead u multiway potu",
  "multiway-preflop-choices": "Preflop odluke koje stvaraju multiway potove",
  "live-game-dynamics": "Po čemu se igre uživo razlikuju",
  "straddle-preflop": "Straddle prije flopa",
  "straddle-postflop-low-spr": "Potovi sa straddleom nakon flopa",
  "deep-stacks-200bb": "Igra s 200 big blindova",
  "population-exploits": "Prilagodba igračima za stolom",
  "player-profiles": "Kako prepoznati tipove igrača",
  "preflop-by-stack-depth": "Preflop s 40, 60, 150 i 200 big blindova",
  "turn-check-raise-and-probe": "Lead i check-raise na turnu",
  "3bp-turn": "3-bet potovi na turnu",
  "3bp-river": "3-bet potovi na riveru",
  "reading-hud-stats": "Statistike protivnika i kada im vjerovati",
  "exploiting-overfolders": "Protiv igrača koji previše foldaju",
  "exploiting-calling-stations": "Protiv igrača koji previše callaju",
  "exploiting-aggressive-players": "Protiv igrača koji previše betaju i raiseaju",
  "underbluffed-rivers": "Betovi na riveru s premalo blefova",
  "node-locking-in-rail": "Zaključavanje čvora u Railu: najbolji odgovor na procjenu",
  "when-not-to-exploit": "Kada ne iskorištavati",
} as Record<string, string>;

const lessons = (n: number) => `${n} ${plural(n, "lekciji", "lekcije", "lekcija")}`;
const cards = (n: number) => `${n} ${plural(n, "kartica", "kartice", "kartica")}`;
const days = (n: number) => `${n} ${plural(n, "dan", "dana", "dana")}`;
const hands = (n: number) => `${n} ${plural(n, "ruka", "ruke", "ruku")}`;

export const courseHr = {
  titles,

  modules: {
    p1: "Otvaranje",
    p2: "Pred raiseom",
    p3: "Blindovi i dubina stacka",
    f1: "Single-raised potovi: raiser u poziciji",
    f2: "Single-raised potovi: raiser izvan pozicije",
    f3: "Single-raised potovi: caller",
    f4: "3-bet i 4-bet potovi",
    f5: "Multiway flopovi",
    t1: "Ponovni bet",
    t2: "Obrana turna",
    t3: "Turn u 3-bet potovima",
    r1: "Bet na riveru",
    r2: "Pred betom na riveru",
    r3: "River u 3-bet potovima",
    x1: "Čitanje igrača",
    x2: "Igrači za stolom",
    x3: "Laboratorij iskorištavanja",
    x4: "Uživo i duboko",
  } as Record<string, string>,

  tracks: {
    preflop: "Preflop",
    flop: "Flop",
    turn: "Turn",
    river: "River",
    exploits: "Iskorištavanje",
  } as Record<string, string>,

  moduleCode: (code: string) => `Modul ${code}`,

  map: {
    heading: "Učenje",
    intro:
      "Tečaj cash pokera redom kojim se igra ruka: preflop, flop situaciju po situaciju, turn, river, a zatim iskorištavanje. Svaka lekcija uči jednu ideju, pusti te da predvidiš prije nego što ti pokaže, i završava vježbom koju generiraju i ocjenjuju Railovi vlastiti chartovi, solver i kalkulatori — a kad si prijavljen, i tvojim vlastitim rukama.",
    introPanel: {
      heading: "Kako Rail uči",
      points: [
        "Nauči jednu ideju, predvidi prije nego što ti lekcija pokaže, pa je vježbaj na situacijama koje dijele i ocjenjuju Railovi vlastiti chartovi, solver i kalkulatori.",
        "Ocjena je EV koji si izgubio u odnosu na Railovu referencu, u big blindovima i kao udio pota: tijesna odluka ne košta gotovo ništa, prava greška košta puno.",
        "Tvoja analiza slaže leakove po big blindovima koje koštaju na 100 ruku, a lekcija s oznakom „Preporučeno” uči situaciju koja te najviše košta.",
        "Kad si prijavljen, lekcija završava tvojim rukama u toj situaciji, najskupljima prvo; pitanja koja promašiš vraćaju se kao kartice za ponavljanje.",
      ],
      more: "Tečaj pretpostavlja osnove. Ideje na kojima gradi su referentne stranice, povezane iz lekcije kad prvi put upotrijebi pojam:",
    },
    reference: {
      heading: "Referenca",
      groups: {
        orientation: "Kako koristiti Rail",
        maths: "Pokerska matematika",
        ranges: "Rasponi i boardovi",
      } as Record<string, string>,
    },
    concepts: "Knjižnica pojmova",
    conceptsHint: "Svaka ideja koju lekcije koriste, s razrađenim primjerom i kalkulatorom.",
    review: (due: number) => `Za ponavljanje: ${cards(due)}`,
    reviewNone: "Nema kartica za ponavljanje",
    reviewLink: "Ponavljanje",
    progress: (done: number, total: number) => `Savladano ${done} od ${total} napisanih lekcija`,
    progressTested: (done: number, tested: number, total: number) => `Savladano ${done} od ${total} napisanih lekcija, testom preskočeno ${tested}`,
    statusLabel: "Stanje",
    status: {
      "not-started": "Nije započeto",
      "in-progress": "U tijeku",
      "tested-out": "Preskočeno testom",
      mastered: "Savladano",
    } as Record<string, string>,
    recheck: (before: number, after: number) => `Ponovi: lošije u tvojim rukama otad (ocijenjenih odluka prije: ${before}, poslije: ${after})`,
    recheckNote:
      "„Ponovi” označava lekciju koju si položio ili preskočio testom, a u čijim situacijama otad igraš lošije, više od šuma uzorka: barem 20 ocijenjenih odluka sa svake strane, po testu koji koristi i pronalazak propusta. Manje ruku, ili tek naginjanje, nikad ne vraća lekciju.",
    capstone: (code: string) => `Ponavljanje modula ${code}`,
    placement: "Test razine",
    placementHint: "Već dobro igraš ove situacije? Preskoči modul testom umjesto da prolaziš lekciju po lekciju.",
    comingSoon: "Uskoro",
    recommended: "Preporučeno",
    recommendedLeak: (per100: string) => `Preporučeno: ovdje gubiš ${per100} bb na 100 ruku`,
    recommendedFlag: (count: number, flag: string) => `Preporučeno: ${count} tvojih odluka s oznakom „${flag}”`,
    recommendedNote:
      "Preporuke dolaze iz tvojih leakova na trenutnoj verziji analize: situacije koje te najviše koštaju, uparene s lekcijom koja ih uči.",
    localNote: "Tvoj napredak čuva se samo u ovom pregledniku. Prijavi se da ga spremiš na račun i vježbaš na vlastitim rukama.",
    signIn: "Prijava",
    accountNote: "Tvoj napredak čuva se na tvom računu.",
    merge: {
      body: (count: number) => `Ovaj preglednik ima napredak na ${lessons(count)} iz vremena kad nisi bio prijavljen.`,
      add: "Dodaj ga na ovaj račun",
      discard: "Odbaci ga",
      done: "Dodano na tvoj račun.",
    },
    lessonCount: (written: number, total: number) => `Napisano ${written} od ${total} lekcija`,
    prereqs: "Prvo pročitaj:",
  },

  lesson: {
    breadcrumb: "Učenje",
    goals: "U ovoj lekciji",
    prereqs: "Prvo pročitaj",
    prereqsNote: "Savjet, ne zaključavanje: svaka lekcija je otvorena.",
    concepts: "Korišteni pojmovi",
    heuristics: "Pravila palca",
    breaks: "Kad ne vrijede",
    practice: "Vježba",
    practiceIntro:
      "Lekcija je savladana kad položiš svaku vježbu ispod koju Rail može ocijeniti. Pitanja koja promašiš vraćaju se kasnije kao kartice za ponavljanje.",
    exerciseLabel: (n: number) => `Vježba ${n}`,
    passRule: (needed: number, count: number) => `Za prolaz: ${needed} od ${count} točno`,
    passed: "Položeno",
    notYet: "Još nije položeno",
    best: (correct: number, total: number) => `Zadnji pokušaj: ${correct} od ${total}`,
    mastered: "Lekcija savladana",
    masteredBody: "Svaka ocijenjena vježba je položena. Ponavljanje se brine da ti se promašaji vraćaju.",
    next: "Sljedeća lekcija",
    previous: "Prethodna lekcija",
    back: "Natrag na tečaj",
    comingSoonTitle: "Ova lekcija stiže uskoro",
    comingSoonBody:
      "Njezin sažetak je ovdje da vidiš gdje se uklapa. Napisana lekcija i njezine vježbe stižu s jednom od sljedećih faza tečaja.",
    comingSoonPractice: "Vježbe koje će imati:",
    referenceEyebrow: "Referenca",
    referenceGoals: "Na ovoj stranici",
    referenceNote: "Referentna stranica: ideja koju tečaj pretpostavlja, bez vježbi i napretka. Lekcije ovamo vode kad prvi put upotrijebe pojam.",
    optional: "Neobavezno",
    notCounted: "Ne broji se za prolaz",
  },

  notes: {
    "flop-mapped":
      "Vježbe na flopu ovdje se dijele iz Railove knjižnice flopova: dvanaest heads-up linija za 6-max i 100bb, svaka riješena na 100 reprezentativnih flopova. Flop u vježbi uvijek je jedan od njih, pa se ocjenjuje kombinacija po kombinaciju. Tvoje ruke na bilo kojem drugom flopu čitaju se s najbližeg riješenog flopa po kategoriji ruke, a analiza takve ocjene označava kao mapirane.",
    "multiway-heuristic":
      "Railova knjižnica flopova je heads-up. Flopove s više igrača analiza čita heuristikom i podjelom minimalne obrane, s činjenicama i oznakama, ali bez ocjene solvera, pa su vježbe u ovoj lekciji računske i na tvojim rukama.",
    "approximate-ranges":
      "Približno: rasponi ovdje su ručno napisani rasponi za učenje ili počivaju na Railovom modelu sužavanja, a ne na rješenju cijele ruke. Ono što treba zapamtiti je smjer.",
    "turn-tree":
      "Rail rješava turn s jednom veličinom beta, tri četvrtine pota, plus all-in kad su stackovi kratki, i grubim riverom ispod njega: isto stablo koje ocjenjuje tvoje turnove. Manji betovi na turnu i overbetovi ovdje se uče riječima i na riveru, čije rješenje ima više veličina.",
    conceptual: "Konceptualno: Rail ovu situaciju još ne analizira, pa lekcija uči ideju bez ocijenjene vježbe.",
    "straddle-not-analysed": "Rail analizira samo jedan straddle: jedan straddle od 2 bb sa sjedala lijevo od big blinda, za 4-6 igrača, oko 100 bb. Ostali potovi sa straddleom uče se riječima.",
    "locked-read":
      "Exploit laboratorij zaključava jednu protivnikovu sklonost na riveru koji Rail rješava na zahtjev, ostatak protivnikove strategije ostavlja kakav je u solveu i računa tvoj najbolji odgovor. Zaključavanje je tvoja procjena igrača, a ne činjenica, i laboratorij radi samo na riveru; rasponi počivaju na Railovu modelu sužavanja.",
  } as Record<string, string>,

  exerciseKinds: {
    "chart-quiz": "Preflop situacije iz Railovih chartova, ocijenjene kao što analiza ocjenjuje tvoje ruke",
    "solver-spot": "Situacije nakon flopa koje Railov solver rješava na licu mjesta",
    calc: "Brojevi koje izračunaš prije nego što ih kalkulator pokaže",
    classify: "Boardovi i ruke za razvrstavanje, ocijenjeni Railovim čitačem boarda i ruke",
    "own-hands": "Tvoje vlastite analizirane ruke u ovoj situaciji",
    "range-split": "Razvrstavanje klasa ruku cijelog raspona po akcijama, ocijenjeno Railovim rješenjem po klasi",
    "depth-split": "Razvrstavanje klasa ruku na 200bb naspram 100bb (planirano)",
    "range-paint": "Bojanje raspona na mreži 13×13, ocijenjeno polje po polje prema Railovu chartu ili rješenju",
    "range-walk": "Pogađanje raspona street po street na tvojoj ruci (planirano)",
    "node-lock": "Zaključavanje protivnikove sklonosti u Railovu solveru i igranje najboljeg odgovora protiv nje",
  } as Record<string, string>,

  checkpoint: {
    label: "Predvidi",
    hint: "Odaberi odgovor, pa pogledaj zašto.",
    right: "Točno.",
    wrong: (answer: string) => `Ne baš — odgovor je „${answer}”.`,
    reveal: "Railov kalkulator, s ovim brojevima:",
  },

  exercise: {
    start: "Počni",
    restart: "Pokušaj ponovno",
    next: "Dalje",
    check: "Provjeri",
    yourAnswer: "Tvoj odgovor",
    progress: (at: number, count: number) => `${at} od ${count}`,
    score: (correct: number, total: number) => `${correct} od ${total} točno`,
    resultPassed: (correct: number, total: number) => `${correct} od ${total} točno — položeno.`,
    resultFailed: (correct: number, total: number, needed: number) =>
      `${correct} od ${total} točno — potrebno je ${needed}. Pokušaj ponovno kad budeš spreman.`,
    cardsAdded: (count: number) =>
      `${count} ${plural(count, "promašeno pitanje dodano je", "promašena pitanja dodana su", "promašenih pitanja dodano je")} u tvoje kartice za ponavljanje.`,
    saved: "Spremljeno.",
    savedLocal: "Spremljeno u ovom pregledniku.",
    saveFailed: (message: string) => `Spremanje nije uspjelo: ${message}`,
    correct: "Točno",
    incorrect: "Netočno",
    answerWas: (answer: string) => `Odgovor: ${answer}`,
    generating: "Dijelim…",
    solving: "Railov solver rješava situaciju…",
    grading: "Ocjenjujem…",
    failed: (message: string) => `Nešto je pošlo po zlu: ${message}`,
    retry: "Pokušaj ponovno",
    noSpot: "Nijedna situacija ne odgovara ovim postavkama. Pokušaj ponovno.",
    planned: {
      "depth-split": "Planirano: razvrstaj isti raspon na 200bb i na 100bb i usporedi obje podjele s Railovim rješenjima.",
      "range-paint": "Planirano: oboji raspon pozicije sa straddleom na mreži 13×13, kad Rail dobije straddle chartove s kojima ga može usporediti.",
      "range-walk": "Planirano: ponovno odigraj svoju ruku i pogađaj protivnikov raspon na svakom streetu, pa usporedi s Railovim sužavanjem.",
      "node-lock": "Planirano: zaključaj protivnikovu učestalost u jednoj odluci, ponovno je riješi Railovim solverom i usporedi najbolji odgovor s osnovnom strategijom.",
    } as Record<string, string>,
    waits: {
      widget: "Ova vježba treba alat koji još nije napravljen.",
      "flop-library": "Čeka rješenja flopova na ovoj dubini: Railova knjižnica flopova pokriva samo heads-up linije za 6-max i 100bb.",
      "villain-stats": "Čeka statistiku protivnika u analizi.",
      "straddle-charts": "Čeka chartove za straddle, kojih Rail još nema.",
    } as Record<string, string>,
    flopOff: "Situacije na flopu trebaju Railovu knjižnicu flopova, koja još nije uključena. Vježba se otvara kad bude.",
    flopUnavailable:
      "Situacije na flopu dijele se iz Railove knjižnice flopova, do koje ova kopija Raila ne može doći (nema postavljenu bazu). Vježba radi na objavljenoj stranici.",
  },

  flopBets: {
    line: "Linija",
    lines: {
      "btn-bb": "Button otvara, big blind calla (buttonu se checka)",
      "utg-bb": "UTG otvara, big blind calla (UTG-u se checka)",
      "btn-bb-3bet": "Big blind 3-beta button i prvi je na potezu",
    } as Record<string, string>,
    caption: (flops: number) => `Prva odluka preflop raisera na flopu na ${flops} flopova koje je Rail riješio, po skupinama boardova`,
    group: "Skupina boardova",
    flops: "Flopovi",
    bet: "Beta",
    big: "Beta veliko",
    groups: {
      "ace-high": "As visoko, bez para",
      "king-queen-high": "Kralj ili dama visoko, bez para",
      middle: "Dečko do osmice visoko, bez para",
      low: "Sedmica visoko ili niže, bez para",
      monotone: "Monoton",
      paired: "Upareni",
      trips: "Tris na boardu",
    } as Record<string, string>,
    source:
      "Railova vlastita knjižnica flopova: rasponi iz chartova za 6-max i 100bb za tu liniju, riješeni na svakom flopu s betovima od 33 % i 75 % pota. „Beta“ je udio cijelog raspona koji beta; „beta veliko“ udio koji beta 75 % ili all-in. Svaki riješeni flop broji se jednom, pa je broj za skupinu obični prosjek njezinih flopova.",
  },

  split: {
    question: (street: string) =>
      `Ovdje je cijeli tvoj raspon na ${street === "river" ? "riveru" : street === "turn" ? "turnu" : "flopu"}. Stavi svaku klasu ruku tamo gdje misliš da je Railovo rješenje najčešće igra.`,
    groups: { check: "Check", small: "Mali bet", big: "Veliki bet", overbet: "Overbet", fold: "Fold", call: "Call", raise: "Raise" } as Record<string, string>,
    you: "Ti",
    first: (street: string) => `Ti si prvi na potezu na ${street === "river" ? "riveru" : street === "turn" ? "turnu" : "flopu"}.`,
    // The hero's own step reads the same in Croatian ("Ti: check."), so `self` is not needed here.
    step: (who: string, kind: string, sizePot: number) =>
      kind === "check"
        ? `${who}: check.`
        : kind === "call"
          ? `${who}: call.`
          : kind === "allin"
            ? `${who}: all-in.`
            : `${who}: ${kind === "raise" ? "raise" : "bet"} od ${Math.round(sizePot * 100)} % pota.`,
    pot: (pot: string, toCall: string | null) => (toCall ? `Pot ${pot} · za call ${toCall}` : `Pot ${pot}`),
    share: (share: string) => `${share} tvog raspona`,
    check: "Provjeri moju podjelu",
    railMix: (mix: string) => `Rail: ${mix}`,
    overall: (mix: string) => `Cijeli tvoj raspon, kako ga Rail igra: ${mix}.`,
    result: (correct: number, total: number, passed: boolean) =>
      `${correct} od ${total} klasa tamo gdje ih Rail igra${passed ? " — računa se kao točno." : " — nedovoljno da se računa kao točno."}`,
    libraryNote: (line: string, iterations: string, exploitability: string) =>
      `Iz Railove knjižnice flopova: rasponi iz chartova za ${line} riješeni na ovom flopu (betovi od 33 % i 75 % pota, jedan raise, all-in), ${iterations} iteracija, unutar ${exploitability} % pota. Mali bet ovdje je do pola pota. Klasa se računa kao točna kad Rail tvoj izbor igra najviše 15 postotnih bodova rjeđe od svog najčešćeg.`,
    turnNote:
      "Iz rješenja turna na licu mjesta: preflop rasponi iz chartova suženi na flopu Railovim heurističkim modelom, turn riješen s betom od 75 % pota i all-inom. Klasa se računa kao točna kad Rail tvoj izbor igra najviše 15 postotnih bodova rjeđe od svog najčešćeg.",
    riverNote:
      "Iz rješenja rivera na licu mjesta: preflop rasponi iz chartova suženi na flopu i turnu Railovim heurističkim modelom, river riješen s betovima od 33 %, 75 % i 150 % pota i all-inom. Mali bet je do pola pota, veliki do pota, overbet veći. Klasa se računa kao točna kad Rail tvoj izbor igra najviše 15 postotnih bodova rjeđe od svog najčešćeg.",
    made: {
      "fh+": "Full house ili bolje",
      flush: "Boja",
      straight: "Skala",
      set: "Set",
      trips: "Tris",
      "two-pair": "Dva para",
      overpair: "Overpar",
      "tp-top": "Gornji par, najbolji kicker",
      "tp-good": "Gornji par, dobar kicker",
      "tp-weak": "Gornji par, slab kicker",
      middle: "Drugi par ili par ispod najviše karte",
      weak: "Slab par ili underpar",
      "ace-high": "As visoko",
      nothing: "Bez para",
    } as Record<string, string>,
    draws: {
      combo: "dro na boju i skalu",
      nfd: "dro na najjaču boju",
      fd: "dro na boju",
      oesd: "otvoreni dro na skalu",
      gut: "gutshot",
      bd: "backdoor dro",
    } as Record<string, string>,
  },

  paint: {
    questionOpen: (seat: string) => `Oboji svaku ruku koju ${seat} igra kad svi prije njega foldaju: raise ili limp.`,
    questionBet: "Oboji ruke svog raspona ovdje koje Railovo rješenje beta.",
    questionContinue: "Oboji ruke svog raspona ovdje s kojima Railovo rješenje nastavlja: call ili raise.",
    how: (inside: string, outside: string, pass: string) =>
      `Klikni ili povuci za bojanje, rade i strelice i razmaknica. Ruku koju Rail igra barem ${inside} puta treba obojiti, onu koju igra najviše ${outside} ostaviti praznom, a sve između računa se kako god. Trebaš ${pass} ruku koje se računaju, ponderirano kombinacijama.`,
    cell: (hand: string, on: boolean) => `${hand}, ${on ? "obojeno" : "nije obojeno"}`,
    cellGraded: (hand: string, on: boolean, share: string, state: string | null) =>
      `${hand}, ${on ? "obojeno" : "nije obojeno"}, Rail ${share}${state === "right" ? ", točno" : state === "missed" ? ", treba obojiti" : state === "extra" ? ", treba ostaviti prazno" : ""}`,
    notInRange: (hand: string) => `${hand}: nije u rasponu ovdje`,
    railShare: (hand: string, share: string) => `${hand}: Rail ${share}`,
    clear: "Očisti",
    check: "Provjeri moje bojanje",
    result: (score: string, passed: boolean) => `${score} ruku koje se računaju točno${passed ? " — računa se kao točno." : " — nedovoljno da se računa kao točno."}`,
    counts: (missed: number, extra: number) =>
      `Neobojenih ruku koje Rail igra: ${missed} (−); obojenih ruku koje Rail ne igra: ${extra} (+).`,
    legend: "✓ točno · − treba obojiti · + treba ostaviti prazno. Pređi mišem preko ruke ili je fokusiraj da vidiš koliko je Rail igra.",
    chartNote: (set: string) => `Iz Railova charta ${set}: udio igre svake ruke kad svi prije te pozicije foldaju.`,
    riverNote: (iterations: string, exploitability: string) =>
      `Iz rješenja rivera na licu mjesta (preflop rasponi iz chartova suženi na flopu i turnu Railovim heurističkim modelom; betovi od 33 %, 75 % i 150 % pota i all-in; ${iterations} iteracija, unutar ${exploitability} % pota). Udio ruke računa se na kombinacijama koje tvoj raspon ovdje još drži.`,
  },

  mastery: {
    title: "U tvojim rukama otkad si ga položio",
    titleTested: "U tvojim rukama otkad si je preskočio testom",
    loading: "Čitam tvoje analizirane ruke…",
    failed: (message: string) => `Ne mogu pročitati tvoje ruke: ${message}`,
    noSpots: "Ova lekcija nije vezana uz jednu situaciju iz pronalaska propusta, pa je Rail ne može mjeriti na tvojim rukama.",
    since: (day: string) => `Tvoje ocijenjene odluke u situacijama ove lekcije, prije i nakon ${day}.`,
    before: "Prije",
    after: "Nakon",
    decisions: (n: number) => `odluka: ${n}`,
    perDecision: (bb: string, pot: string) => `${bb} izgubljeno po odluci (${pot} pota)`,
    mistakes: (rate: string) => `${rate} ocijenjeno kao Netočno ili gore`,
    none: "Nema ocijenjenih odluka",
    tooFew: (min: number) => `Još nema dovoljno ruku: Rail imenuje promjenu od ${min} ocijenjenih odluka sa svake strane.`,
    trend: {
      better: "Bolje otkad si je položio: promjena je veća od šuma uzorka.",
      "leaning-better": "Naginje boljem otkad si je položio, ali to još može biti šum.",
      steady: "Otprilike isto kao prije: uzorak još ne vidi promjenu.",
      "leaning-worse": "Naginje lošijem otkad si je položio, ali to još može biti šum. Ponavljanje lekcije može pomoći.",
      worse: "Lošije otkad si je položio, više od šuma uzorka. Vrijedi ponovno pogledati lekciju.",
      "too-few": "Još nema dovoljno ruku.",
    } as Record<string, string>,
    method:
      "Mjereno prosječnom ocjenom poteza testom koji koristi i pronalazak propusta, na rukama odigranima prije i nakon dana kad si položio lekciju, na trenutnoj verziji analize. Ništa se ne sprema: ažurira se kako učitavaš i analiziraš nove ruke.",
  },

  spot: {
    flopNote: (line: string, iterations: string, exploitability: string) =>
      `Situacija na flopu iz Railove knjižnice flopova: rasponi iz chartova za ${line} riješeni na ovom flopu (betovi od 33 % i 75 % pota, jedan raise, all-in; ${iterations} iteracija, unutar ${exploitability} % pota), isto rješenje kojim se ocjenjuju tvoji flopovi na ovoj liniji.`,
    flopFirst: "Ti si prvi na potezu na flopu.",
    raised: (villain: string, to: number) => `${villain} raisea na ${String(Math.round(to * 100) / 100).replace(".", ",")} bb.`,
    lineName: (id: string) => {
      const parts = id.split("-");
      const seats = parts.filter((p) => p !== "3bet" && p !== "limp").map((p) => p.toUpperCase());
      return `${seats.join("–")}${parts.includes("3bet") ? ", 3-bet pot" : parts.includes("limp") ? ", limpani pot" : ""}`;
    },
    turnNote:
      "Situacija na turnu: Rail rješava turn i grubi river (bet od 75 % pota ili all-in), isto rješenje kojim analiza ocjenjuje turnove. Traje sekundu-dvije.",
    ownCards: "Tvoja ruka",
    turnFirst: "Ti si prvi na potezu na turnu.",
    turnRanges:
      "Rasponi: preflop rasponi iz chartova, suženi na flopu heurističkim modelom — približno, isto ono na čemu počivaju ocjene turna u analizi.",
  },

  calc: {
    units: {
      pct: "%",
      bb: "bb",
      count: "kombinacija",
      chances: "prilika",
    } as Record<string, string>,
    tolerance: (value: string) => `uz odstupanje do ${value}`,
    questions: {
      "pot-odds": (pot: string, bet: string) => `U potu je ${pot}, a protivnik beta ${bet}. Koliko equityja treba callu?`,
      "outs-equity": "Obje karte tek dolaze i nitko više ne beta. Koliko često tvoja ruka pobjeđuje (izjednačenje se broji kao pola)?",
      ev: (pot: string, bet: string, folds: string, equity: string) =>
        `Betaš ${bet} u pot od ${pot}. Protivnik folda u ${folds} slučajeva; kad platiš call, pobjeđuješ u ${equity} slučajeva i više nema betanja. Koliki je EV beta?`,
      combos: (hand: string, shape: string) => `Koliko kombinacija ${hand} (${shape}) protivnik još može imati?`,
      "alpha-mdf-alpha": (size: string) => `Betaš ${size} pota kao čisti blef. Koliko često protivnik mora foldati da blef bude na nuli?`,
      "alpha-mdf-mdf": (size: string) => `Protivnik beta ${size} pota. Koliki dio tvog raspona mora nastaviti da čisti blef ne bi bio profitabilan?`,
      spr: (pot: string, stack: string) => `Pot na flopu je ${pot}, a u efektivnom stacku iza je ${stack}. Koliki je SPR?`,
      grade: (pot: string) => `Pot ${pot}. Opcije referentne strategije su ispod, a ti si odigrao označenu. Koju ocjenu dobiva?`,
      steal: (open: string, blinds: string) => `Otvaraš na ${open}, a u blindovima je ${blinds}. Koliko često svi moraju foldati da open sam po sebi bude na nuli?`,
      "blind-price": (open: string) => `Button otvara na ${open}, small blind folda. Koliko equityja treba big blindu za call?`,
      per100: (lost: string, handsCount: string) => `Tvoj izvještaj o leakovima kaže da si izgubio ${lost} kroz ${handsCount} ocijenjenih ruku. Koliko je to bb na 100 ruku?`,
      "allin-ev": (stack: string, dead: string, equity: string) =>
        `Protivnik gura all-in za ${stack}; u potu je već ${dead}. Plaćaš s ${equity} equityja. Koliki je EV calla?`,
      "multiway-all-fold": (opponents: number, folds: string) =>
        `Blefiraš u ${opponents} protivnika, a svaki sam za sebe folda u ${folds} slučajeva. Koliko često foldaju svi?`,
      "multiway-mdf-split": (opponents: number, size: string) =>
        `Bet od ${size} pota ide u ${opponents} igrača. Koliki dio raspona svaki mora braniti da zajedno ne foldaju više nego što bet treba?`,
      "sample-margin": (value: string, n: string) =>
        `Protivnikova statistika pokazuje ${value} kroz ${n} prilika. Koliko daleko s obje strane seže interval od 95% (u postotnim bodovima)?`,
      "sample-needed": (value: string, margin: string) =>
        `Statistika je blizu ${value}. Koliko prilika treba prije nego što joj interval od 95% bude unutar ± ${margin}?`,
      "pot-tracking": "Igra uživo za punim stolom, blindovi $0,5/$1, svi s 200 bb. Broji kako ruka ide: koliko je big blindova u potu kad se podijeli turn?",
    },
    potSteps: {
      preflop: "Preflop",
      flop: "Flop",
      act: (position: string, type: string, to: string) =>
        type === "fold"
          ? `${position} folda`
          : type === "check"
            ? `${position} checka`
            : type === "call"
              ? `${position} plaća call`
              : type === "bet"
                ? `${position} beta ${to}`
                : `${position} raisea na ${to}`,
    },
    combosShape: {
      pair: "par",
      suited: "suited ruka",
      "offsuit-or-suited": "ruka, suited i offsuit zajedno",
    } as Record<string, string>,
    working: {
      "pot-odds": (afterCall: string, call: string, answer: string) => `Ako platiš, pot je ${afterCall}, a ${call} od toga je tvoje: ${answer}.`,
      "outs-equity": (outs: number, rule4: string, exact: string) =>
        `${outs} ${plural(outs, "karta", "karte", "karata")} na turnu te stavlja u vodstvo. Prečac ×4 kaže oko ${rule4}; prebrojavanje svakog turna i rivera daje ${exact}.`,
      ev: (foldPart: string, callPart: string, answer: string) => `Foldovi: ${foldPart}. Callovi: ${callPart}. Ukupno: ${answer}.`,
      combos: (total: number, removed: number, left: number) =>
        `U punom špilu ima ${total} ${plural(total, "kombinacija", "kombinacije", "kombinacija")}; karte koje vidiš uklanjaju ${removed}, ostaje ${left}.`,
      alpha: (alpha: string, mdf: string) => `Alfa (potrebni foldovi) je ${alpha}; MDF je druga strana: ${mdf}.`,
      spr: (answer: string) => `Stack ÷ pot = ${answer}.`,
      grade: (evLoss: string, evLossPot: string) => `Gubitak EV-a ${evLoss} (${evLossPot} pota).`,
      steal: (answer: string) => `Rizik ÷ (rizik + nagrada) = ${answer}.`,
      "blind-price": (pot: string, call: string, answer: string) => `Big blind plaća ${call} da igra za ${pot} plus call: ${answer}.`,
      per100: (answer: string) => `Izgubljeno ÷ ruke × 100 = ${answer}.`,
      "allin-ev": (win: string, lose: string, required: string, answer: string) =>
        `Pobjeda: +${win}. Poraz: ${lose}. Call treba ${required} equityja; njegov EV je ${answer}.`,
      multiway: (alpha: string, answer: string) => `Bet ukupno treba ${alpha} foldova; odgovor je ${answer}.`,
      "sample-margin": (variance: string, answer: string) => `1,96 × √(${variance} ÷ prilike) = ${answer}.`,
      "sample-needed": (variance: string, answer: string) => `1,96² × ${variance} ÷ margina² = ${answer} prilika.`,
      "pot-tracking": (preflop: string, flop: string, answer: string) => `Prije flopa ušlo je ${preflop} (s blindovima), a na flopu ${flop}: ${answer}.`,
    },
    revealWidget: "Kalkulator, s ovim brojevima:",
    cards: { flop: "Flop", board: "Board", you: "Ti", opponent: "Protivnik" },
    inputLabel: (unit: string) => (unit ? `Tvoj odgovor (${unit})` : "Tvoj odgovor"),
    invalid: "Upiši broj.",
    optionsTable: {
      option: "Opcija",
      freq: "Referentna frekvencija",
      ev: "EV",
      chosen: "Odigrano",
    },
  },

  classify: {
    questions: {
      texture: {
        suits: "Koliko boja ima ovaj flop?",
        pairing: "Je li flop uparen?",
        connectedness: "Koliko je ovaj flop povezan?",
        "high-card": "Kojoj klasi pripada najviša karta flopa?",
      } as Record<string, string>,
      dynamism: "Je li ovaj flop statičan, dinamičan ili nešto između?",
      "hand-class": "Gdje je tvoja ruka na ovom flopu?",
      "range-advantage": "Open s buttona protiv calla iz big blinda: je li na ovom flopu otvarač jasno ispred ili je tijesno?",
      "nut-advantage": "Open s UTG-a protiv calla iz big blinda: otvarač ima više najjačih ruku. Je li ta prednost ovdje velika ili mala?",
      "turn-card": "Open s buttona protiv calla iz big blinda. Pomaže li ova karta na turnu otvaraču, calleru ili nikome?",
      "profile-read": "Što ova statistika podržava, po pravilu koje koristi odjeljak o tvom poolu?",
    },
    profileStat: (made: number, chances: number, value: string) =>
      `Protivnik je foldao na ${made} od ${chances} c-betova na flopu (${value}). To su brojevi vježbe, ne ničija stvarna statistika.`,
    buckets: {
      texture: {
        rainbow: "Rainbow (tri boje)",
        "two-tone": "Two-tone (dvije iste boje)",
        monotone: "Monotone (jedna boja)",
        unpaired: "Neuparen",
        paired: "Uparen",
        disconnected: "Nepovezan",
        "semi-connected": "Djelomično povezan",
        connected: "Povezan",
        ace: "S asom",
        broadway: "Broadway (najviša T–K)",
        middle: "Srednji (najviša 7–9)",
        low: "Nizak (najviša 6 ili niže)",
      } as Record<string, string>,
      dynamism: { static: "Statičan", medium: "Između", dynamic: "Dinamičan" } as Record<string, string>,
      "hand-class": {
        strong: "Dva para ili jače",
        top: "Top par ili overpar",
        middle: "Slabiji par",
        draw: "Jak draw, bez para",
        air: "Ništa ili slab draw",
      } as Record<string, string>,
      "range-advantage": { raiser: "Otvarač je jasno ispred", close: "Tijesno" } as Record<string, string>,
      "nut-advantage": { big: "Velika prednost", small: "Mala prednost" } as Record<string, string>,
      "turn-card": { raiser: "Otvaraču", neutral: "Nikome", caller: "Calleru" } as Record<string, string>,
      "profile-read": {
        overfolds: "Folda više nego što treba blefu od pola pota",
        underfolds: "Folda manje nego što treba blefu od trećine pota",
        "no-read": "Još nema očitanja",
      } as Record<string, string>,
    },
    detail: {
      volatility: (value: string) => `Volatilnost ${value}: udio sljedećih karata koje mijenjaju board.`,
      straights: (count: number) => `${count} ${plural(count, "kombinacija", "kombinacije", "kombinacija")} od dvije karte daje straight.`,
      equity: (value: string) => `Equity otvaračeva raspona na ovom flopu: ${value}.`,
      nuts: (raiser: string, caller: string) => `U gornjih 10 % ruku: otvarač ${raiser}, caller ${caller}.`,
      shift: (before: string, after: string) => `Equity otvaračeva raspona: ${before} na flopu, ${after} s ovim turnom.`,
      made: (made: string) => `Imaš: ${made}.`,
      profile: (value: string, margin: string, above: string, below: string) =>
        `${value} ± ${margin} (interval od 95%). Blef od pola pota treba ${above} foldova, blef od trećine pota ${below}. Očitanje traži da cijeli interval bude preko jedne od tih crta, uz barem 30 prilika i interval ne širi od ± 10 bodova.`,
    },
    madeHand: {
      "straight-flush": "straight flush",
      quads: "poker (četiri iste)",
      "full-house": "full house",
      flush: "flush",
      straight: "straight",
      set: "set",
      trips: "trips",
      "two-pair": "dva para",
      overpair: "overpar",
      "top-pair": "top par",
      "pocket-pair-below-top": "džepni par ispod najviše karte",
      "second-pair": "drugi par",
      "weak-pair": "slab par",
      underpair: "underpar",
      "ace-high": "as visoko",
      "high-card": "bez para",
      board: "board",
    } as Record<string, string>,
    illustrative: "Ilustrativni rasponi iz knjižnice pojmova, ručno napisani za učenje.",
  },

  lab: {
    presets: {
      overfold: "Previše folda na river betove",
      station: "Previše plaća river betove",
      passive: "Nikad ne raisea river bet",
      underbluff: "Rijetko blefira river",
      maniac: "Puno blefira river",
    } as Record<string, string>,
    lockLine: {
      "fold-to-bet": (shift: string) => `Zaključano: protivnik folda ${shift} bodova na tvoje river betove u odnosu na Railov solve, na svakoj veličini.`,
      "never-raise": () => "Zaključano: protivnik nikad ne raisea tvoje river betove.",
      "air-bets": (share: string) => `Zaključano: protivnik beta ${share} svog zraka (bez para, as-high, promašeni drawovi) kad prvi djeluje na riveru.`,
    } as Record<string, (value: string) => string>,
    lockAt: (where: string, eq: string, locked: string) => `${where} — Railov solve: ${eq}; zaključano: ${locked}.`,
    lockWhat: {
      "fold-to-bet": "foldova",
      "never-raise": "raiseova",
      "air-bets": "zraka koji beta",
    } as Record<string, string>,
    first: "Prvi na potezu",
    action: (kind: string, sizePot: number) =>
      kind === "allin"
        ? "All-in"
        : kind === "bet"
          ? `Bet ${Math.round(sizePot * 100)}%`
          : kind === "raise"
            ? `Raise ${Math.round(sizePot * 100)}%`
            : (({ fold: "Fold", check: "Check", call: "Call" }) as Record<string, string>)[kind] ?? kind,
    preset: "Procjena",
    value: {
      "fold-to-bet": "Foldovi u odnosu na solve",
      "never-raise": "Raiseovi",
      "air-bets": "Zrak koji beta",
    } as Record<string, string>,
    run: "Zaključaj i riješi",
    another: "Drugi river",
    running: "Rješavam river i najbolji odgovor…",
    numbers: "Koliko procjena vrijedi, u bb po riveru iz ovih raspona",
    gain: "Dobitak u odnosu na Railovu osnovu protiv ovog protivnika",
    riskEq: "Trošak ako protivnik zapravo igra kao solve",
    riskCounter: "Trošak ako protivnik to vidi i kontrira",
    baselineRisk: "Trošak same osnove protiv njezina kontriranja",
    ofPot: (bb: string, pct: string) => `${bb} (${pct} pota)`,
    viewTitle: (steps: string) => `Tvoja odluka: ${steps}`,
    category: "Tvoje ruke",
    baseline: "Railov solve",
    response: "Najbolji odgovor",
    overall: "Cijeli raspon",
    question: (category: string) => `Držiš ovu ruku (${category}). Što protiv ovog protivnika radi najbolji odgovor?`,
    railAnswer: (eq: string, best: string) => `Railov solve je igra ${eq}; protiv zaključanog protivnika najbolji odgovor je igra ${best}.`,
    evLine: "EV protiv zaključanog protivnika, po akciji:",
    tolerance: (pct: string) => `Odgovor se računa kao točan unutar ${pct} pota od najbolje akcije.`,
    note: (iterations: string, exploitability: string) =>
      `Iz rješenja rivera na zahtjev (rasponi iz chartova suženi na flopu i turnu Railovim heurističkim modelom; betovi od 33%, 75% i 150% pota i all-in; ${iterations} iteracija, unutar ${exploitability}% pota). Protivnik zadržava strategiju solvea svugdje osim na zaključanom mjestu; ti svugdje igraš najbolji odgovor. Vrijednosti su tvoje očekivanje preko svih dijeljenja obaju raspona na početku rivera.`,
    none: "Rail nije našao river koji ova procjena mijenja. Probaj drugi river ili drugu procjenu.",
  },

  pool: {
    title: "Tvoj vlastiti pool",
    intro: "Sklonosti tvojih protivnika iz tvojih ruku, zbrojene preko panela protivnika, s brojem prilika koje je svaka statistika imala i intervalom od 95% koji taj uzorak dopušta.",
    signIn: "Prijavi se i vodi statistiku protivnika u Statistika → Protivnici da ovdje vidiš svoj pool.",
    noDatabase: "Ova kopija Raila nema bazu, pa nema statistike protivnika za prikaz.",
    loading: "Čitam statistiku tvojih protivnika…",
    failed: (message: string) => `Statistiku protivnika nije bilo moguće pročitati: ${message}`,
    none: "Još nema statistike protivnika. Uključi je u Statistika → Protivnici (sobe koje skrivaju imena između sesija su izostavljene), pa se vrati.",
    opaque: (rows: string) => `Izostavljeno je ${rows} redaka protivnika iz soba čija imena ne preživljavaju sesiju.`,
    summary: (players: string, hands: string) => `${players} protivnika, ${hands} ruku s njima.`,
    capped: (players: string) => `Zbrojeno je samo tvojih ${players} najčešće viđenih protivnika.`,
    stats: {
      vpip: "Uložio novac prije flopa",
      pfr: "Raiseao prije flopa",
      threeBet: "3-bet",
      foldToThreeBet: "Foldao na 3-bet",
      cbet: "C-bet na flopu",
      foldToCbet: "Foldao na c-bet na flopu",
      wtsd: "Došao do showdowna",
      wsd: "Dobio na showdownu",
      aggression: "Betao ili raiseao (odluke nakon flopa)",
    } as Record<string, string>,
    value: (value: string, margin: string, n: string) => `${value} ± ${margin} kroz ${n} prilika`,
    levels: {
      thin: "premalo podataka",
      rough: "gruba procjena",
      settled: "pouzdano",
    } as Record<string, string>,
    noChances: "još nema prilika",
    needed: (n: string) => `Oko ${n} prilika za ± 5 bodova.`,
    read: {
      above: (stat: string, size: string, needs: string) =>
        `Interval statistike „${stat}” tvog poola leži cijeli iznad ${needs} foldova koje treba blef od ${size} pota. Vježbaj protiv toga u laboratoriju:`,
      below: (stat: string, size: string, needs: string) =>
        `Interval statistike „${stat}” tvog poola leži cijeli ispod ${needs} foldova koje treba blef od ${size} pota. Vježbaj protiv toga u laboratoriju:`,
    } as Record<string, (stat: string, size: string, needs: string) => string>,
    noRead: "Ovdje još ništa ne prelazi svoj interval: igraj osnovu i pusti da uzorak naraste prije nego što se osloniš na procjenu.",
    lessonLink: (title: string) => `Lekcija: ${title}`,
  },

  sampleSize: {
    stat: "Statistika",
    chances: "Broj prilika",
    margin: "Interval od 95%",
    range: "Uvjerljiv raspon",
    needed: "Prilike za ± 5 bodova",
    count: (n: string) => `${n} prilika`,
  },

  ownHands: {
    intro: "Tvoje analizirane odluke u ovoj situaciji, najskuplje prve. Odluči prije nego što vidiš što si odigrao i što kaže Railova referenca.",
    signIn: "Prijavi se da vježbaš na vlastitim rukama.",
    none: "Još nema tvojih analiziranih odluka koje odgovaraju ovoj lekciji. Učitaj i analiziraj ruke, pa se vrati.",
    loading: "Tražim tvoje ruke…",
    question: "Što bi odigrao?",
    youPlayed: (move: string, grade: string) => `Odigrao si ${move} (${grade}).`,
    open: "Otvori ruku",
    reviewOnly: "Označeno, ne ocijenjeno: otvori ruku i ponovno pogledaj odluku.",
    approximate: "Vježba, približno: neke od ovih ocjena su heurističke ili počivaju na Railovom modelu sužavanja.",
    done: (count: number) => `Pregledano: ${hands(count)}.`,
  },

  review: {
    heading: "Ponavljanje",
    intro:
      "Pitanja koja si promašio u lekcijama vraćaju se ovdje po rasporedu razmaknutog ponavljanja (istom koji koriste vježbe tvojih grešaka), izmiješana iz svih lekcija.",
    due: (count: number) => `Sad na redu: ${cards(count)}`,
    empty: "Ništa nije na redu. Promašena pitanja iz lekcija pojavit će se ovdje kad opet dođu na red.",
    done: "To su bile sve kartice na redu. Bravo.",
    backIn: (count: number) => (count === 1 ? "Vraća se sutra." : `Vraća se za ${days(count)}.`),
    backSoon: "Vraća se za deset minuta.",
    fromLesson: (title: string) => `Iz lekcije: ${title}`,
    loading: "Učitavam tvoje kartice…",
    stale: "Pitanje s ove kartice nije se moglo ponovno složiti pa je preskočeno.",
  },

  plan: {
    task: (title: string) => `Lekcija: ${title}`,
    open: "Otvori lekciju",
  },

  mixed: {
    skip: "Preskoči",
    new: "Novo",
    review: "Ponavljanje",
  },

  placement: {
    heading: "Test razine",
    intro:
      "Već dobro igraš neke od ovih situacija? Riješi kratki izmiješani test za jedan smjer: nekoliko pitanja iz svakog njegova modula, podijeljenih i ocijenjenih točno kao u lekcijama. Modul koji položiš označava se kao „preskočeno testom”: to je zasebno stanje, ne „savladano”, pa su ti lekcije otvorene kad god ih poželiš.",
    pick: "Odaberi smjer",
    track: (modules: number, items: number) => `modula: ${modules}, pitanja: ${items}`,
    rules: (perModule: number, share: string, min: number) =>
      `${perModule} pitanja po modulu, izmiješana kroz cijeli smjer. Modul se preskače uz ${share} točnih od ocijenjenih pitanja i barem ${min} ocijenjena; pitanje koje se ne može podijeliti možeš preskočiti i ne broji se protiv tebe.`,
    start: (track: string) => `Počni test: ${track}`,
    resultTitle: "Kako je prošlo",
    module: (code: string, name: string, correct: number, graded: number) => `${code} ${name}: ${correct} od ${graded} točno`,
    testedOut: (count: number) => `preskočeno testom: označeno ${lessons(count)}`,
    already: "preskočeno testom — njegove lekcije već su bile položene ili preskočene",
    notYet: "nije preskočeno — kreni odavde:",
    tooFew: "premalo ocijenjenih pitanja za procjenu",
    recorded: "Spremljeno na tvoj račun.",
    recordedLocal: "Spremljeno u ovom pregledniku.",
    again: "Odaberi drugi smjer",
    signedOut: "Dok nisi prijavljen, rezultati se čuvaju samo u ovom pregledniku.",
  },

  capstone: {
    heading: (code: string) => `Ponavljanje modula ${code}`,
    intro: (count: number) =>
      `${count} pitanja izmiješanih iz lekcija ovog modula: situacija iz jedne lekcije, račun iz druge. Prepoznati koju ideju situacija traži pola je posla. Promašena pitanja idu u tvoje kartice za ponavljanje; rezultat se ne sprema.`,
    start: "Počni ponavljanje",
    result: (correct: number, graded: number) => `${correct} od ${graded} točno.`,
    again: "Još jedno ponavljanje",
    empty: "Nijedna lekcija ovog modula još nema vježbu koju Rail ovdje može podijeliti.",
  },

  dose: {
    heading: "Današnjih pet minuta",
    intro: "Nekoliko kartica za ponavljanje koje su na redu i jedno novo pitanje iz lekcije na koju te Rail upućuje: najmanja korisna dnevna navika.",
    plan: (reviews: number, lesson: string | null) => `Za ponavljanje: ${cards(reviews)}${lesson ? `, i jedno novo pitanje iz lekcije „${lesson}”` : ""}.`,
    nothing: "Ništa nije na redu i sve lekcije su gotove. Vrati se sutra.",
    start: "Počni",
    loading: "Pripremam današnja pitanja…",
    done: (correct: number, graded: number) => `Gotovo za danas: ${correct} od ${graded} točno.`,
    doneToday: "Gotovo za danas. Sljedeća doza čeka te sutra.",
    again: "Još jednu",
  },

  examples: {
    heading: "Primjeri ruku",
    intro: "Primjeri dolaze samo s dva mjesta: iz tvojih analiziranih ruku u situacijama ove lekcije i iz ruke koju Rail sam podijeli i ocijeni. Nikad ruka izvan Raila.",
    ownTitle: "Iz tvojih ruku",
    signIn: "Prijavi se, s analiziranim rukama, da ovdje vidiš primjere iz vlastite igre.",
    find: "Pronađi moje primjere",
    loading: "Pregledavam tvoje analizirane ruke…",
    failed: (message: string) => `Ne mogu pročitati tvoje ruke: ${message}`,
    none: "Još nemaš ocijenjenih odluka u situacijama ove lekcije.",
    costliest: "Tvoja najskuplja odluka ovdje",
    perfect: "Tvoja čista ocjena Savršeno ovdje",
    spot: (street: string, position: string | null) => (position ? `${street}, ${position}` : street),
    show: "Pokaži zašto",
    open: "Odigraj je do ove odluke",
    whyMistake: (taken: string, reference: string, loss: string, pot: string | null, grade: string) =>
      `Odigrao si ${taken} (${grade}). Railova referentna strategija radije igra ${reference}; razlika je stajala ${loss}${pot ? `, ${pot} pota` : ""}.`,
    whyPerfect: (taken: string, freq: string, next: string, margin: string) =>
      `Odigrao si ${taken}, što Railova referentna strategija ovdje igra u ${freq} slučajeva. Sljedeća najbolja opcija, ${next}, gubi ${margin}: ovdje se isplatilo pogoditi.`,
    scriptedTitle: "Ruka koju dijeli Rail",
    scriptedIntro: "Rail ovu ruku slaže iz vježbe same lekcije, uvijek istu, i ocjenjuje je analizom. Prvo odluči, pa pročitaj Railovu ocjenu.",
    deal: "Podijeli je",
  },
} as const;

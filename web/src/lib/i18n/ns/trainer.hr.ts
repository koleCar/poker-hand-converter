/**
 * Riječi Trenera (`components/trainer`), hrvatski. Isti oblik kao
 * `trainer.en.ts`.
 */

import { analysisHr } from "./analysis.hr";
import { leaksHr } from "./analysisLeaks.hr";
import { courseHr } from "./course.hr";

const num = (value: number, digits = 0) =>
  value.toLocaleString("hr-HR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const bb = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return `${num(tenth, tenth % 1 !== 0 ? 1 : 0)} bb`;
};
const pct = (value: number) => `${num(Math.round(value * 100))} %`;
/** Akcija kao ime postotka ("postotak folda"). */
const ACTION_HR: Record<string, string> = { fold: "folda", call: "calla", raise: "raisea", bet: "beta", vpip: "VPIP-a", pfr: "PFR-a" };

export const trainerHr = {
  /** The language, for the catalogue's own labels (Analytics' size buckets and hand classes). */
  lang: "hr" as "en" | "hr",
  modesLabel: "Što vježbaš",
  modes: {
    focus: "Za tebe",
    preflop: "Preflop",
    flop: "Flop",
    turn: "Turn",
    river: "River",
  } as Record<string, string>,
  modeHints: {
    focus: "Spotovi iz tvojih leakova, najskuplji prvi",
    preflop: "Chartovi: open, obrana, 3-bet, 4-bet",
    flop: "Heads-up flopovi iz Railove flop biblioteke",
    turn: "Turn riješen na licu mjesta",
    river: "River riješen na licu mjesta",
  } as Record<string, string>,

  settings: "Postavke",
  settingsTitle: "Postavke trenera",
  close: "Zatvori",
  reset: "Vrati zadano",
  sections: { spot: "Spot", play: "Trening", show: "Prikaz" },
  table: "Stol",
  tableValue: (players: number, stack: number, straddle = false, ante = false) =>
    `${players === 2 ? "Heads-up" : `${players}-max`} ${num(stack)}bb${straddle ? " straddle" : ante ? " ante" : ""}`,
  family: "Situacija",
  families: {
    random: "Bilo koja",
    rfi: "Prvi ulaziš",
    "vs-open": "Protiv opena",
    "vs-3bet": "Protiv 3-beta",
    squeeze: "Squeeze",
    bvb: "Blind protiv blinda",
    "vs-limp": "Protiv limpa",
    "vs-4bet": "Protiv 4-beta",
  } as Record<string, string>,
  hero: "Ti",
  vs: "Protiv",
  any: "Bilo koji",
  pot: "Pot",
  pots: { any: "Bilo koji", srp: "Single-raised", "3bp": "3-bet", limped: "Limpan" } as Record<string, string>,
  side: "Pozicija",
  sides: { any: "Svejedno", ip: "U poziciji", oop: "Bez pozicije" } as Record<string, string>,
  role: "Preflop",
  roles: { any: "Svejedno", pfr: "Ti si raiseao", caller: "Ti si callao" } as Record<string, string>,
  facing: "Pred tobom",
  facings: { any: "Bilo što", check: "Check", bet: "Bet", raise: "Raise" } as Record<string, string>,
  line: "Linija",
  deal: "Ruke",
  deals: { range: "Kako ih range drži", borderline: "Uglavnom tijesne odluke" } as Record<string, string>,
  pause: "Nakon odgovora",
  pauses: { always: "Uvijek čekaj", mistakes: "Čekaj samo nakon greške" } as Record<string, string>,
  strategy: "Strategija za tvoju ruku",
  on: "Uključeno",
  off: "Isključeno",

  rangePanel: "Range dok odgovaraš",
  ranges: { range: "Samo range", strategy: "Range i strategija" } as Record<string, string>,
  rangeHeading: "Tvoj range ovdje",
  rangeLoading: "Čitam range…",
  rangeNone: "Za ovaj spot nema rangea.",
  rangeCombos: (combos: number, share: number) => `${num(Math.round(combos))} kombinacija · ${pct(share)} svih ruku`,
  rangeAll: "Cijeli range",
  rangeShow: "Prikaži ruke koje",
  tabs: {
    label: "Više o ovom spotu",
    range: "Range",
    strategy: "Strategija",
    facts: "Tvoja ruka",
    why: "Zašto",
    afterAnswer: "Nakon odgovora",
  },
  timebankLabel: "Vrijeme za odgovor",
  timebanks: { "0": "Bez sata", "7": "7 s", "15": "15 s", "25": "25 s" } as Record<string, string>,
  timeLeft: (seconds: number) => `${num(seconds)} s`,
  timeUp: "Vrijeme je isteklo",
  buttonsLabel: "Gumbi",
  buttonsValues: { all: "Svaka veličina", simple: "Jedan po akciji" } as Record<string, string>,
  simpleBet: "Bet",
  simpleRaise: "Raise",
  inputLabel: "Odgovaraš",
  inputs: { action: "Jednom akcijom", frequency: "Miksom akcija" } as Record<string, string>,
  mixSubmit: "Odgovori",
  mixHint: "Podijeli 100 % na akcije: koliko često bi igrao svaku.",
  mixAccuracy: (share: number) => `Točnost ${pct(share)}`,
  mixYours: "Ti",
  mixRef: "Solver",
  tablesLabel: "Stolovi",
  tablesNote: "Svaki svoj spot; tipke idu prvom stolu koji čeka odgovor.",
  drills: {
    heading: "Moji drillovi",
    none: "Još nema spremljenih drillova.",
    name: "Naziv",
    placeholder: "npr. BB protiv BTN, flop, protiv beta",
    save: "Spremi ove postavke",
    remove: (name: string) => `Obriši ${name}`,
    open: (name: string) => `Otvori ${name}`,
  },
  history: {
    heading: "Zadnji odgovori",
    none: "Tvoji odgovori se čuvaju ovdje, na ovom računalu.",
  },
  sessions: {
    newSession: "Nova sesija",
    sortLabel: "Poredaj sesije",
    sorts: { recent: "Nedavne", hands: "Ruke", score: "Score" } as Record<string, string>,
    archived: "Arhivirane",
    columns: { session: "Sesija", hands: "Ruke", score: "Score", grades: "Ocjene", evLost: "Izgubljeni EV", played: "Zadnje igrano" },
    todayCount: (n: number) => `+${num(n)} danas`,
    continue: "Nastavi",
    menu: (name: string) => `${name}: više`,
    review: "Pregled povijesti",
    rename: "Preimenuj",
    renameSave: "Spremi",
    fromThese: "Nova sesija s ovim postavkama",
    archive: "Arhiviraj",
    restore: "Vrati",
    none: "Odaberi što ćeš trenirati, daj tome ime i vraćaj se kad god želiš.",
    noneArchived: "Nema arhiviranih sesija.",
    loading: "Učitavam tvoje sesije…",
    failed: (message: string) => `Sesije se nisu mogle pročitati: ${message}`,
    all: "Sve sesije",
    title: "Nova sesija",
    name: "Ime sesije",
    nameAuto: "Ime se slaže iz postavki dok ne upišeš svoje.",
    nameOwn: "Tvoje ime.",
    auto: "Auto",
    start: "Pokreni sesiju",
    startAnyway: "Ipak pokreni novu",
    cancel: "Odustani",
    changeNote: (name: string, hands: number) =>
      `Promijenjene postavke pokreću novu sesiju. ${name} ostaje kakva jest${hands > 0 ? `, sa svojih ${num(hands)} ruku` : ""}.`,
    duplicate: (name: string) => `Ove postavke već treniraš u sesiji ${name}`,
    duplicateMeta: (hands: number, score: string) => `${num(hands)} ruku · score ${score}`,
    continueIt: "Nastavi nju",
    changeSettings: "Promijeni postavke",
    locked: "Postavke su zaključane za ovu sesiju",
    periods: { today: "Danas", all: "Sve" } as Record<string, string>,
    hands: "Ruke",
    score: "Score",
    playedAgain: "Odigrano ponovno",
    spots: (n: number) => `${num(n)} ${n % 10 === 1 && n % 100 !== 11 ? "spot" : "spotova"}`,
    rightNow: (share: number) => `${pct(share)} sad točno`,
    mistakesFirst: "Spotovi koje si pogriješio vraćaju se prvi.",
    repeatLabel: "Ponovi odigrane spotove",
    repeats: { off: "Isključeno", some: "Ponekad", often: "Često" } as Record<string, string>,
    repeatHints: {
      off: "Svaki spot je nov.",
      some: "Otprilike jedan spot od šest vraća se iz ove sesije, prvo tvoje greške. Nakon odgovora vidiš što si tada odigrao.",
      often: "Otprilike jedan spot od tri vraća se iz ove sesije, prvo tvoje greške. Nakon odgovora vidiš što si tada odigrao.",
    } as Record<string, string>,
    seen: {
      title: "Ovaj spot si već igrao",
      same: "iste karte, isti spot",
      better: "Bolje nego prošli put",
      worse: "Lošije nego prošli put",
      unchanged: "Isto kao prošli put",
      now: "Sad",
    },
    names: {
      anySeat: "Bilo koja pozicija",
      firstIn: (seat: string) => `${seat} prvi u igri`,
      versus: (seat: string, vs: string, what: string) => `${seat} protiv ${vs}${what ? ` ${what}` : ""}`,
    },
    when: {
      today: (time: string) => `Danas ${time}`,
      yesterday: (time: string) => `Jučer ${time}`,
    },
    reviewing: {
      inDays: (days: number) => `u ${num(days)} ${days % 10 === 1 && days % 100 !== 11 ? "dan" : "dana"}`,
      perHand: (bb: number) => `−${num(bb, 3)} bb po ruci`,
      bestStreak: "Najbolji niz",
      chart: "Score po 20 ruku",
      chartRange: (hands: number) => `ruka 1 → ${num(hands)}`,
      groups: { type: "Vrsta ruke", best: "Najbolji potez", seat: "Pozicija", street: "Street", day: "Dan" } as Record<string, string>,
      groupLabel: "Grupiraj po",
      groupHint: "Ruke · score · izgubljeni EV. Klikni red da filtriraš ruke.",
      filters: { all: "Sve", bad: "Greške i blunderi", inaccurate: "Netočno", ok: "Savršeno i dobro" } as Record<string, string>,
      again: "Igrano više puta",
      count: (n: number) => `${num(n)} ${n % 10 === 1 && n % 100 !== 11 ? "ruka" : "ruku"}`,
      cols: { when: "Kad", hand: "Ruka", move: "Tvoj potez", best: "Najbolje", grade: "Ocjena", ev: "Izgubljeni EV", times: "×" },
      every: "Svaki put kad si je igrao",
      playAgain: "Odigraj ponovno",
      noMatch: "Nijedna ruka ne odgovara.",
      empty: "U ovoj sesiji još nema odgovora.",
      handTypes: {
        pairs: "Parovi",
        aces: "Ax",
        broadway: "Broadwayi i Kx",
        suited: "Suited connectori i gapperi",
        other: "Ostale ruke",
      } as Record<string, string>,
    },
  },
  dealing: "Dijelim…",
  solving: "Rješavam…",
  loadingFlop: "Učitavam flop…",
  grading: "Ocjenjujem…",
  noSpot: "Nijedan spot ne odgovara ovim postavkama. Olabavi jednu i pokušaj ponovno.",
  unavailable: {
    flop: "Flop spotovi trebaju flop knjižnicu solvanu na GTO Wizard rangeovima; još je nema.",
    set: "Ovaj stol još nije prepisan iz GTO Wizarda: nema se što dijeliti. Odaberi drugi stol u postavkama.",
  },
  failed: (message: string) => `Nešto je pošlo po zlu: ${message}`,
  retry: "Pokušaj ponovno",

  potOf: (value: number) => `Pot ${bb(value)}`,
  /** Lost EV, signed: "−4.20 bb", "0.00 bb". */
  lostBb: (value: number) => `${value > 0 ? "−" : ""}${num(value, 2)} bb`,
  toCall: (value: number) => `${bb(value)} za call`,
  stack: (value: number) => `${bb(value)} iza`,
  yourMove: "Tvoj potez",
  board: { flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>,

  next: "Sljedeća ruka",
  solver: {
    open: "Pogledaj u Solveru",
    title: "Otvori Solver na ovom spotu. Kad se vratiš u Trener, sesija se nastavlja odavde.",
    looking: "Tražim spot…",
    none: "Solver ovdje nema spot.",
  },
  autoNext: "Sljedeća ruka za trenutak…",
  stay: "Ostani",
  you: (label: string) => `Ti: ${label}`,
  best: (label: string) => `Najbolje: ${label}`,
  evLost: (value: number) => `−${num(value, 2)} bb`,
  noLoss: "Bez gubitka EV-a",
  inStrategy: (share: number) => `igra se ${pct(share)} puta`,
  notInStrategy: "ovdje se nikad ne igra",
  strategyHeading: "Što solver radi s ovom rukom",
  evHeading: "EV",
  whyHeading: "Zašto",
  ruleOfThumb: "Pravilo",
  details: {
    sizing: (note: import("../../training/details").SizingNote, label: (index: number) => string): string => {
      const low = (index: number) => {
        const text = label(index);
        return text.charAt(0).toLowerCase() + text.slice(1);
      };
      const worth = (value: number) => `${num(value, 2)} bb`;
      switch (note.kind) {
        case "size-better":
          return `${label(note.better)} je bolja veličina: donosi ${worth(note.bb)} više od tvog poteza (${low(note.chosen)}).`;
        case "size-best":
          return note.bb > 0
            ? `Tvoja veličina je ovdje najbolja od ${note.raise ? "raiseova" : "betova"}: donosi ${worth(note.bb)} više od sljedeće (${low(note.next)}).`
            : `Tvoja veličina i ${low(note.next)} ovdje vrijede isto.`;
        case "passive-better":
          return `${label(note.passive)} je ovdje bolji od ${note.sizes > 1 ? `svakog ${note.raise ? "raisea" : "beta"}` : note.raise ? "raisea" : "beta"}: donosi ${worth(note.bb)} više od ${note.sizes > 1 ? "najbolje veličine" : "njega"} (${low(note.best)}).`;
        case "aggressive-better":
          return `${note.raise ? "Raise" : "Bet"} je ovdje bolji: ${low(note.best)}${note.sizes > 1 ? " (najbolja veličina)" : ""} donosi ${worth(note.bb)} više od tvog poteza (${low(note.chosen)}).`;
        case "passive-right":
          return note.bb > 0
            ? `${label(note.chosen)} je ovdje točan potez: ${note.sizes > 1 ? `najbolji ${note.raise ? "raise" : "bet"}, ` : ""}${low(note.best)}, donosi ${worth(note.bb)} manje.`
            : `${label(note.chosen)} i ${low(note.best)} ovdje vrijede isto.`;
      }
    },
    blockers: (b: import("../../training/details").BluffBlockers): string[] => {
      const suit = (code: string) => ({ s: "♠", h: "♥", d: "♦", c: "♣" })[code] ?? code;
      const card = (code: string) => `${code[0]}${suit(code[1])}`;
      const join = (items: string[], last: string) =>
        items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
      const group = (g: import("../../training/details").BlockerGroup) => {
        switch (g.kind) {
          case "flush":
            return `${join(g.cards.map(card), "ili")} (flushevi)`;
          case "straight":
            return `${join(g.ranks, "ili")} (skala)`;
          case "top-pair":
            return `${join(g.ranks, "ili")} (top par)`;
          case "missed-flush":
            return `bilo koji ${suit(g.suit)} (promašeni flush drawovi)`;
          case "missed-straight":
            return `${join(g.ranks, "ili")} (promašeni straight drawovi)`;
        }
      };
      const out: string[] = [];
      if (b.good.length > 0) out.push(`Za blef su dobre karte koje uklanjaju ruke koje callaju: ${b.good.map(group).join("; ")}.`);
      if (b.bad.length > 0) out.push(`Loše su one koje uklanjaju ruke koje bi foldale: ${b.bad.map(group).join("; ")}.`);
      const good = join(b.mine.good.map(card), "i");
      const bad = join(b.mine.bad.map(card), "i");
      const goodIs = b.mine.good.length === 1 ? "je dobar bloker" : "su dobri blokeri";
      const badIs = b.mine.bad.length === 1 ? "je loš bloker" : "su loši blokeri";
      const yours = (n: number) => (n === 1 ? "Tvoj" : "Tvoji");
      if (good && bad) out.push(`${yours(b.mine.good.length)} ${good} ${goodIs}, a ${bad} ${badIs}.`);
      else if (good) out.push(`${yours(b.mine.good.length)} ${good} ${goodIs}.`);
      else if (bad) out.push(`${yours(b.mine.bad.length)} ${bad} ${badIs}.`);
      else out.push("Nijedna tvoja karta nije među njima.");
      return out;
    },
    blocks: (names: string[]) =>
      `Tvoje karte blokiraju ${names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} i ${names[names.length - 1]}`}.`,
  },
  principles: {
    rfi: "Kad prvi ulaziš, što je manje igrača iza tebe, to otvaraš šire: s ranih pozicija samo ruke koje ostaju jake protiv više rangeova, s buttona i small blinda puno više. Suited, povezane ruke i parovi otvaraju se prije offsuit ruku iste jačine jer rade jake ruke i dobro se igraju nakon flopa.",
    "vs-open": "Protiv opena referenca uglavnom 3-beta ili folda, a calla uži dio rangea: ruke koje se dobro igraju nakon flopa, više njih u poziciji. Svaka pozicija iza tebe može squeezati, a flat call ostavlja ti ograničen (capped) range.",
    "vs-open-sb": "Small blind igra skoro 3-bet ili fold: call je bez pozicije cijelu ruku, poziva big blind na squeeze i ništa ne zatvara. 3-betaj ruke koje žele pot i one koje blokiraju openerove najjače ruke; ostalo pusti.",
    "vs-open-bb": "Big blind već ima blind u potu i zatvara akciju: cijena je dobra i nitko iza ne može squeezati, pa brani široko, uglavnom callom. Foldaj samo ono što bez pozicije ne može realizirati equity; 3-betaj vrh i nešto suited blokera.",
    "vs-3bet": "Protiv 3-beta nastavljaš s rukama koje tuku 3-betterov value ili se dobro igraju kao call (parovi, suited broadwayi, suited konektori u poziciji). 4-betaj najjače i nekoliko ruku s blokerom asa ili kralja; foldaj dominirane offsuit ruke.",
    squeeze: "S openom i callerom ispred squeezaj uže od običnog 3-beta, ali polarizirano: jake ruke za value i nekoliko blokera kao blef. Callerov range je ograničen, a opener je stisnut između dva igrača, pa je pot često odmah tvoj.",
    bvb: "Blind protiv blinda rangeovi su najširi u igri: iza nema nikoga, pa small blind napada s puno ruku, a big blind u poziciji brani puno. Ovdje pozicija i igrivost ruke vrijede više od same jačine.",
    "vs-limp": "Protiv limpera raiseaj za izolaciju s rukama koje dobro igraju heads-up i u poziciji; overlimpaj suited i povezane ruke koje vole multiway pot; foldaj offsuit ruke kojima treba fold equity koji nemaš.",
    "vs-4bet": "Protiv 4-beta nastavlja samo vrh rangea: jamaj premium parove i AK, callaj s rijetkim rukama koje se dobro igraju duboko, ostalo foldaj, uključujući većinu ruku koje si 3-betao kao blef.",
    "flop-cbet": "Kao preflop raiser obično imaš jači range: na suhim, visokim boardovima mali bet s većinom rangea puno zarađuje; na niskim, povezanim boardovima koji pogađaju callera checkaj više i betaj veće s polariziranim rangeom.",
    "flop-check-to-raiser": "Bez pozicije protiv preflop raisera checkaj skoro cijeli range: raiser na većini flopova ima više jakih ruku. Lead (donk) ima smisla samo na boardovima koji jasno idu tvom rangeu.",
    "flop-vs-bet": "Protiv beta na flopu brani dovoljno da blefovi ne prolaze automatski (vidi minimalnu obranu), i to rukama koje mogu nastaviti na turnu: parovi, drawovi i dobri backdoori. Raiseaj najjače ruke i najbolje drawove; foldaj ruke bez ičega za popraviti.",
    "flop-vs-raise": "Raise na flopu je jak i polariziran: nastavi s jakim gotovim rukama i drawovima koji mogu puno dobiti, a foldaj ruke s jednim parom koje tuku samo blefove.",
    "turn-barrel": "Na turnu nastavi betati na kartama koje popravljaju tvoj range (overkarte, karte koje zatvaraju drawove koje predstavljaš) i s rukama koje imaju equity; odustani sa zrakom koja je promašila. Value ruke nastavljaju betati.",
    "turn-first": "Kao caller na turnu checkaj većinu rangea raiseru; betaj sam kad turn karta prebaci prednost tebi (zatvara drawove s kojima callaš, uparuje niske karte koje držiš).",
    "turn-vs-bet": "Protiv beta na turnu cijena i equity i dalje vrijede, ali draw ima još samo jednu kartu: callaj s gotovim rukama koje su ispred dovoljno blefova i s drawovima koji često pogode ili budu plaćeni kad pogode.",
    "river-first": "Na riveru nema više equityja za boriti se: betaj za value s rukama koje slabije ruke callaju, blefiraj s rukama koje ne mogu dobiti na showdownu (najbolje ako blokiraju ruke koje callaju), a sredinu checkaj.",
    "river-vs-bet": "Protiv beta na riveru ti si bluff-catcher: callaj kad tvoja ruka tuče dovoljno betterovih blefova da pokrije pot odds. Najbolji bluff-catcheri blokiraju betterov value, a ne blokiraju blefove.",
    "river-vs-raise": "Raise na riveru je u praksi rijetko blef, a u teoriji je jako polariziran: nastavi s rukama pri vrhu svog rangea, ostalo foldaj.",
  } as Record<string, string>,
  notGraded: (reason: string) => `Ovaj odgovor nije bilo moguće ocijeniti: ${reason}.`,
  learnMore: "Pročitaj više",

  play: {
    label: "Koliko ruke",
    spot: "Jedan spot",
    hand: "Cijela ruka",
    continue: "Nastavi",
    thinking: "Protivnik razmišlja…",
    starting: "Dijelim ruku…",
    noHand: "Nijedna ruka ne odgovara ovim postavkama. Olabavi jednu i pokušaj ponovno.",
    won: (bb: number) => `Dobio si ${num(bb, 1)} bb`,
    lost: (bb: number) => `Izgubio si ${num(bb, 1)} bb`,
    even: "Izašao si na nulu",
    split: "Podijeljen pot",
    villainFolded: "Protivnik je foldao",
    heroFolded: "Foldao si",
    showdown: "Showdown",
    noReference: "Rail ovdje nema referencu za tvoju sljedeću odluku, pa ruka staje.",
    approximate: "Negdje protivnik nije imao referencu pa je checkao ili callao.",
    summary: "Ova ruka",
    evLostTotal: (bb: number) => `Izgubljeni EV kroz ruku: ${num(bb, 2)} bb`,
    vs: (hero: string, villain: string) => `${hero} protiv ${villain}`,
  },
  focus: {
    working: "Radiš na",
    costs: (per100: number) => `košta te ${num(per100, 2)} bb/100`,
    yourMistake: (taken: string, best: string) => `ti ${taken} gdje je ${best} ispravno`,
    nextArea: "Sljedeći leak",
    none: "U tvojim analiziranim rukama još nema leakova koje trener može podijeliti. Vježbaš spotove koje većina igrača griješi.",
    signIn: "Prijavi se i analiziraj ruke: trener tada dijeli spotove u kojima najviše gubiš.",
    loading: "Čitam tvoje leakove…",
    general: "Spotovi koje većina griješi",
  },

  /** Trener otvoren iz Analitike (docs/ANALYTICS.md korak 9). */
  analytics: {
    from: "Iz Analitike",
    back: "← Natrag na statistiku",
    costs: (per100: number) => `košta te −${num(per100, 2)} bb/100`,
    approximate: "Rail ne može podijeliti baš ovaj spot, pa dijeli najbliži.",
    hands: (action: string) => (action === "fold" ? "Ruke koje često foldaš" : "Ruke iz Analitike"),
    size: "Bet na koji odgovaraš",
    facingSize: (size: string) => `Protiv beta od ${size} pota`,
    goal: "Cilj iz Analitike",
    rateHere: (action: string) => `Tvoj postotak ${ACTION_HR[action] ?? action} ovdje`,
    target: "Solver",
    targetCharts: "Tablice",
    drill: "Ova vježba",
    drillRef: (value: string) => `referenca ${value} na ovim rukama`,
    few: "Odgovori na nekoliko ruku",
    dealtFrom: (classes: string) => `Ruke se dijele iz klasa u kojima griješiš: ${classes}.`,
    later: "Analitika pokazuje je li se spot pomaknuo kako stižu nove ruke.",
    playIt: "Tvoja ruka, kako si je odigrao",
    playNote: "Dijeli se jednom iz tvoje ruke. Nakon nje vježba se nastavlja.",
    playLoading: "Učitavam tvoju ruku…",
    playMissing: "Ova se ruka nije mogla učitati. Vježba se nastavlja.",
    playOn: "Nastavi s vježbom",
  },

  session: {
    label: "Ova sesija",
    answers: "Ruke",
    accuracy: "Točno",
    streak: "Niz",
    best: "Najbolji",
    evLost: "Izgubljeni EV",
    reset: "Ispočetka",
  },
  keysHeading: "Prečaci",
  keys: "1–6 odgovor · F fold · C call / check · A all-in · N sljedeća · S postavke",

  /** Kratki zašto (`lib/training/brief.ts`). */
  brief: {
    roles: {
      value: "Value",
      thin: "Thin value",
      trap: "Value",
      "too-thin": "Pretanko",
      showdown: "Showdown value",
      "bluff-catcher": "Bluff-catcher",
      bluff: "Blef",
      "give-up": "Bez blefa",
      weak: "Preslabo",
      protect: "Ispred, ranjivo",
      vulnerable: "Ispred, ranjivo",
      "semi-bluff": "Semi-blef",
      draw: "Draw",
      medium: "Srednja ruka",
      open: "Open",
      "three-bet": "3-bet",
      "four-bet": "4-bet",
      defend: "Obrana",
    } as Record<string, string>,
    plays: {
      "bet-small": "mali bet",
      "bet-big": "veliki bet",
      raise: "raise",
      allin: "all-in",
      check: "check",
      call: "call",
      fold: "fold",
    } as Record<string, string>,
    head: (role: string | null, play: string | null) =>
      role && play ? `${role} — ${play}` : role ? role : play ? play.charAt(0).toUpperCase() + play.slice(1) : "",
    gain: (kind: "over-yours" | "found" | "equal", best: string, other: string, value: number) => {
      const worth = `+${num(value, 2)} bb`;
      if (kind === "over-yours") return { before: `${best} donosi `, value: worth, after: ` više od tvog poteza (${other}).` };
      if (kind === "found") return { before: `Točno: ${best} donosi `, value: worth, after: ` više od sljedećeg (${other}).` };
      return { before: `${best} i ${other} ovdje vrijede isto.`, value: "", after: "" };
    },
    point: (p: import("../../training/brief").BriefPoint): { lead: string; text: string } => {
      const names = (list: string[], words: Record<string, string>) => list.map((x) => words[x] ?? x).join(", ");
      switch (p.kind) {
        case "beats":
          return { lead: `Pobjeđuje ${pct(p.beats)}`, text: "njihovog rangea." };
        case "price":
          return { lead: `Treba ti ${pct(p.need)}`, text: p.have !== null ? `za call; imaš ${pct(p.have)}.` : "za call." };
        case "equity":
          return { lead: `${pct(p.equity)} equityja`, text: "protiv njihovog rangea." };
        case "polar":
          return { lead: "Njihov range je polariziran:", text: `${pct(p.strong)} jakih, ${pct(p.weak)} slabih ruku.` };
        case "merged":
          return { lead: "Njihov range je merged:", text: `${pct(p.medium)} srednjih ruku.` };
        case "removes":
          return {
            lead: p.strong > p.weak ? "Blokiraš njihove jake ruke:" : "Blokiraš njihove slabe ruke:",
            text: `${pct(p.strong)} jakih, ${pct(p.weak)} slabih.`,
          };
        case "blockers":
          return { lead: "Blokiraš", text: `${names(p.blockers, analysisHr.handFacts.blockers)}.` };
        case "rivers-weak":
          return { lead: `${pct(p.share)} rivera`, text: "pretvara tvoju ruku u gubitničku." };
        case "rivers-strong":
          return { lead: `${pct(p.share)} rivera`, text: "ti donosi jaku ruku." };
        case "draws":
          return { lead: "Drawovi:", text: `${names(p.draws, analysisHr.handFacts.draws)}.` };
        case "spr":
          return { lead: `SPR ${num(p.spr, 1)}:`, text: "sljedeći bet te veže za pot." };
        case "capped":
          return { lead: "Ograničeno na Mistake:", text: "rangeovi su procijenjeni." };
        case "estimate":
          return { lead: "Procjena:", text: "multiway, nije riješeno." };
      }
    },
    groups: {
      value: "Value",
      thin: "Thin value",
      bluff: "Blefovi",
      raise: "Raise",
      bet: "Bet",
      call: "Call",
      check: "Check",
      fold: "Fold",
    } as Record<string, string>,
    showHand: (hand: string) => `Prikaži ${hand} u rangeu`,
    evOf: (label: string) => `EV za ${label}`,
    details: "Detalji",
    examples: "Primjeri ruku",
  },
  zoom: {
    combos: (n: number) => `kombinacija: ${num(n)}`,
    you: "ti",
    actions: { bet: "Bet", raise: "Raise", allin: "All-in", check: "Check", call: "Call", fold: "Fold" } as Record<string, string>,
  },

  words: {
    grades: analysisHr.grades,
    option: analysisHr.sheet.option,
    chartAction: analysisHr.charts.action,
    details: analysisHr.details,
    reasons: analysisHr.reasons,
    handFacts: analysisHr.handFacts,
    lineName: courseHr.spot.lineName,
    leakTitle: leaksHr.title,
    leakContext: leaksHr.fullContext,
    leakActions: leaksHr.actions,
  },
};

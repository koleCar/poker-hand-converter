import type { LessonBodies } from "./types";

/**
 * F2 — single-raised potovi, preflop raiser izvan pozicije, hrvatski (Learn
 * L2). Ista struktura kao `f2.en.ts`, isti `checks`.
 */
export const f2Hr: LessonBodies<"oop-as-the-raiser" | "facing-a-check-raise"> = {
  "oop-as-the-raiser": {
    sections: [
      {
        heading: "Isti raspon, lošije mjesto",
        blocks: [
          "Small blind otvara na 3 bb, a big blind calla. Pot je 3 + 3 = 6 bb, a iza je 97 bb, SPR oko 16,2. Small blind je prvi raiseao i ima jači raspon, ali sada je prvi na potezu na svakom streetu.",
          "Igrati prvi košta [[equity-realisation-and-implied-odds|realizacije equityja]]. Svaki check može biti napadnut, svaki bet može dobiti raise dok big blind još čeka vidjeti što ćeš dalje, a srednje ruke teško jeftino stižu do showdowna. Zato raiser izvan pozicije beta rjeđe nego što bi isti raspon u poziciji, i checka više srednjih ruku.",
        ],
      },
      {
        heading: "Gdje i dalje beta, a gdje checka",
        blocks: [
          "U Railovim rješenjima small blinda protiv big blinda board odlučuje gotovo sve. Na boardovima s kraljem i damom, i na onima s asom, small blind beta većinu raspona, uglavnom malo. Na niskim boardovima, sa sedmicom i niže, checka gotovo sve: raspon calla big blinda ondje ima više malih parova, dva para i skala.",
          "Srednji boardovi su između: manje betova, i više njih velikih. Obrazac je onaj iz pozicije, s kotačićem okrenutim prema checku.",
          {
            widget: { id: "range-vs-range", focus: "nuts", preset: "btn-vs-bb", board: ["6d", "5c", "3h"] },
            caption:
              "Ilustrativni rasponi napisani za učenje: prednost raisera u jakim rukama na 6♦5♣3♥, u usporedbi s K♦7♣2♥. Na niskom boardu caller ima više vrha.",
          },
          {
            checkpoint: {
              question: "Small blind protiv big blinda, flop 6♦5♣3♥. Koji je prirodan plan small blinda?",
              options: ["Mali bet s cijelim rasponom", "Check većine raspona, uključujući jake ruke", "Veliki bet s overpairovima, a check ostalog"],
              answer: 1,
              explain:
                "Niski board pogoduje rasponu big blinda: mali parovi slažu setove, suited connectori skale i dva para. Betati u takav raspon izvan pozicije sa srednjim rukama skupo je, pa small blind puno checka, i drži svoje overpairove i setove među checkovima kako big blind ne bi mogao slobodno napadati svaki check.",
            },
          },
        ],
      },
      {
        heading: "Raspon checka koji se zna obraniti",
        blocks: [
          "Kad puno checkaš, checkovi ne smiju svi biti slabi. Ako svaka jaka ruka beta, big blind nakon tvog checka može betati bilo koje dvije karte, a ti nemaš čime uzvratiti. Kad u rasponu checka zadržiš nešto jakih ruku, možeš check-callati i check-raiseati, i upravo to tvoje checkove čini teškima za napad.",
          "Kad izvan pozicije betaš, bet je malo polariziraniji nego u poziciji: jake ruke i dobri drawovi, s manje tankih value betova. Trećina pota ovdje je 2 bb, a čisti blef te veličine treba 2 / (6 + 2) = 25 % foldova.",
          {
            note: {
              tone: "approximate",
              text: "Vježbe na flopu dijele se iz Railove knjižnice flopova, u kojoj je small blind protiv big blinda single-raised linija s raiserom izvan pozicije. Tvoje ruke na flopovima koje knjižnica nije riješila čitaju se s najbližeg riješenog flopa po kategoriji ruke.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Izvan pozicije betaj rjeđe i checkaj više srednjih ruku nego što bi isti raspon u poziciji.",
        "Betaj visoke boardove kojima tvoj raspon dominira; checkaj većinu niskih boardova koji pogoduju calleru.",
        "Drži jake ruke među checkovima da caller ne može slobodno betati u njih.",
        "Kad betaš izvan pozicije, naginji polariziranom: jake ruke i dobri drawovi.",
      ],
      breaks: [
        "Protiv big blinda koji nikad ne beta kad mu se checka, check jakih ruku gubi value: betaj ih.",
        "Protiv onoga koji beta nakon svakog checka, checkaj više jakih ruku i pusti ga da beta.",
      ],
    },
    exercises: {
      "oop-flops": "Pet flopova iz Railove knjižnice, small blind protiv big blinda, tvoja prva odluka: check ili bet, i koliko veliko.",
      "oop-rivers": "Tri rivera kao raiser izvan pozicije, riješena na zahtjev.",
      "your-hands": "Tvoje odluke na flopu kao raiser izvan pozicije, najskuplje prve.",
    },
    checks: [
      { fn: "sum", args: [3, 3], value: 6 },
      { fn: "sum", args: [100, -3], value: 97 },
      { fn: "spr", args: [97, 6], value: 16.2 },
      { fn: "alpha", args: [6, 2], value: 0.25 },
    ],
  },

  "facing-a-check-raise": {
    sections: [
      {
        heading: "Cijena check-raisea",
        blocks: [
          "Button protiv big blinda, pot 5,5 bb. Betaš trećinu pota, oko 1,8 bb, a big blind raisea na 6,35 bb, pola pota nakon svog calla. Sada plaćaš 4,55 bb u pot od 5,5 + 1,8 + 6,35 = 13,65 bb: za call trebaš 4,55 / (13,65 + 4,55) = 25 % equityja, ako više novca ne uđe.",
          "Sa strane raisera, check-raise riskira 6,35 bb da osvoji 7,3 bb koji su već u potu. Kao čisti blef treba 6,35 / (7,3 + 6,35), oko 46,5 % foldova: to je njegova [[bluffing-math-alpha-mdf|alfa]], a 1 minus ona, oko 53,5 %, udio je tvog raspona koji je betao, a mora nastaviti da blef-raise ne bi tiskao novac.",
          {
            checkpoint: {
              question: "Suočen si s tim check-raiseom: 4,55 bb za call u 13,65 bb. Koliko equityja call treba, ako više novca ne uđe?",
              options: ["Oko 18 %", "Oko 25 %", "Oko 33 %"],
              answer: 1,
              explain: "Nakon tvog calla pot je 13,65 + 4,55 = 18,2 bb, od čega je 4,55 bb tvoje: 4,55 / 18,2 = 25 %. Kasniji streetovi donose dodatni rizik rukama koje ne podnose nove betove, pa call treba nešto više od gole cijene.",
              math: { fn: "requiredEquity", args: [13.65, 4.55], value: 0.25 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 13.65, bet: 4.55, share: 0.25 },
            },
          },
        ],
      },
      {
        heading: "Koje ruke nastavljaju",
        blocks: [
          "Minimalna obrana je mekan vodič, a ne pravilo. U Railovim rješenjima buttona protiv big blinda button protiv check-raisea nastavlja češće od tog minimuma: velik dio njegova raspona koji beta su parovi i drawovi s pravim equityjem protiv raisea.",
          {
            list: [
              "Nastavi: jake gotove ruke, top parovi, overpairovi i drawovi s dobrim equityjem: drawovi na boju, otvoreni drawovi na skalu, gutshotovi s overkartama.",
              "Miješano: slabiji parovi s backdoor drawovima i ruke koje blokiraju najjače kombinacije raisera.",
              "Fold: zrak koji je betao kao blef i nema ništa više, bez para i bez drawa.",
            ],
          },
          "Prednost daj rukama s equityjem pred tankim gotovim rukama. Srednji par bez drawa ima malo dobrih karata na turnu i suočava se s još betova; draw na boju ima ih mnogo.",
        ],
      },
      {
        heading: "Protiv stvarnih igrača",
        blocks: [
          "Mnogi igrači check-raiseaju flop gotovo samo s jakim rukama. Protiv njih minimalna obrana je previše: foldaj slabe parove i nastavi s rukama koje mogu pobijediti jak raspon ili imaju draw na nuts. Protiv igrača koji često check-raiseaju s drawovima i zrakom zadrži svoje parove.",
          "U Railovu stablu flopa check-raise je posljednji raise na streetu, pa vježbe postavljaju jedno pitanje: call ili fold.",
          {
            note: {
              tone: "approximate",
              text: "Vježbe dolaze iz Railove knjižnice flopova, kombinacija po kombinaciju. Tvoje ruke na flopovima koje knjižnica nije riješila čitaju se s najbližeg riješenog flopa po kategoriji ruke, a analiza ih označava kao mapirane.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Odredi cijenu calla: raise koji plaćaš podijeljen s potom nakon tvog calla.",
        "Nastavi s equityjem: drawovi i parovi s dobrim outovima prije tankih gotovih ruku.",
        "Foldaj zrak koji je betao kao blef.",
        "[[bluffing-math-alpha-mdf|Minimalnu obranu]] shvati kao mekan vodič.",
      ],
      breaks: [
        "Protiv igrača koji check-raiseaju samo jake ruke foldaj više nego što vodič kaže.",
        "S dubljim stackovima implied odds idu u prilog drawovima, a štete rukama s jednim parom.",
      ],
    },
    exercises: {
      "flop-vs-raise": "Pet flopova iz Railove knjižnice na kojima je tvoj bet na flopu dobio raise: fold ili call, ocijenjeno rješenjem.",
      "your-hands": "Tvoji betovi na flopu koji su dobili raise, najskuplji prvi.",
    },
    checks: [
      { fn: "sum", args: [5.5, 1.8, 1.8], value: 9.1 },
      { fn: "product", args: [0.5, 9.1], value: 4.55 },
      { fn: "sum", args: [1.8, 4.55], value: 6.35 },
      { fn: "sum", args: [5.5, 1.8, 6.35], value: 13.65 },
      { fn: "alpha", args: [7.3, 6.35], value: 0.465 },
      { fn: "mdf", args: [7.3, 6.35], value: 0.535 },
    ],
  },
};

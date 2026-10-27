import type { LessonBodies } from "./types";

/**
 * F5 — flopovi s više igrača, hrvatski (Learn L2). Ista struktura kao
 * `f5.en.ts`, isti `checks`.
 */
export const f5Hr: LessonBodies<"multiway-principles" | "multiway-as-the-raiser" | "multiway-defence"> = {
  "multiway-principles": {
    sections: [
      {
        heading: "Svaki dodatni igrač je nova prilika za jaku ruku",
        blocks: [
          "Heads-up blef uspijeva ako jedan igrač folda. S dva protivnika oba moraju foldati; s tri, sva tri. Ako svaki sam folda u pola slučajeva, oba foldaju u 0,5 × 0,5 = 25 % slučajeva, a sva tri tek u 12,5 %.",
          "Ista računica radi i obrnuto za jake ruke. Što više igrača vidi flop, to je vjerojatnije da netko ima dva para, set ili jak draw, i to je srednja ruka u lošijem položaju.",
          {
            widget: { id: "multiway", pot: 9, bet: 3, share: 0.5, opponents: 2 },
            caption: "Bet od trećine pota u dva igrača od kojih svaki folda u pola slučajeva. Dodaj trećeg protivnika i gledaj kako foldovi na koje možeš računati padaju.",
          },
        ],
      },
      {
        heading: "Obrana je zajednička",
        blocks: [
          "Minimalna obrana tiče se cijelog stola, a ne svakog igrača. Protiv beta od trećine pota 25 % foldova svih zajedno najviše je što branitelji smiju dopustiti. Kad ih je dvoje, ako svaki nastavi s pola raspona, svi foldaju u 0,5 × 0,5 = 25 % slučajeva: svaki brani 50 %, dok bi sam branitelj trebao 75 %.",
          {
            checkpoint: {
              question: "Bet od trećine pota ide u tri igrača. Koliki dio raspona svaki mora braniti ako posao dijele jednako?",
              options: ["Oko 25 %", "Oko 37 %", "Oko 75 %"],
              answer: 1,
              explain: "Svi foldaju najviše u 25 % slučajeva: svaki igrač folda najviše treći korijen od 25 %, oko 63 %, pa svaki brani oko 37 %.",
              math: { fn: "mdfSplit", args: [3, 1, 3], value: 0.37 },
              reveal: { id: "multiway", pot: 3, bet: 1, share: 0.37, opponents: 3 },
            },
          },
        ],
      },
      {
        heading: "Što se mijenja",
        blocks: [
          {
            list: [
              "Blefiraj manje, i s rukama koje se još mogu popraviti.",
              "Betaj za value malo uže i malo manje.",
              "Prednost daj rukama koje slažu nuts pred drawovima na drugu najbolju ruku.",
              "Slowplayaj manje: svaka besplatna karta besplatna je za nekoliko igrača.",
            ],
          },
          {
            note: {
              tone: "approximate",
              text: "Railova knjižnica flopova je heads-up. Flopove s više igrača analiza čita heuristikom i podjelom MDF-a, s činjenicama i oznakama, ali bez ocjene solvera; vježba u ovoj lekciji je računica i tvoje označene ruke.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Pomnoži foldove: blef treba da folda svaki protivnik.",
        "Podijeli obranu: svaki igrač brani manje nego heads-up.",
        "Betaj uže i manje; slowplayaj manje.",
        "Prednost daj drawovima na nuts pred drawovima na drugu najbolju ruku.",
      ],
      breaks: [
        "Pasivni multiway stolovi koji previše callaju nagrađuju tanki value i još jače kažnjavaju blefove.",
        "S kratkim stackom iza vezanost dolazi brže, bilo multiway ili ne.",
      ],
    },
    exercises: {
      "multiway-maths": "Šest računa: koliko često svi foldaju i koliko svaki igrač mora braniti.",
      "your-hands": "Tvoje ruke označene zbog blefa u gomilu, slowplaya u multiway potu ili calla s dominiranim drawom.",
    },
    checks: [
      { fn: "allFold", args: [0.5, 2], value: 0.25 },
      { fn: "allFold", args: [0.5, 3], value: 0.125 },
      { fn: "mdfSplit", args: [3, 1, 2], value: 0.5 },
    ],
  },

  "multiway-as-the-raiser": {
    sections: [
      {
        heading: "Bet u dvojicu",
        blocks: [
          "Raiseao si preflop, a dva igrača su callala. Dolazi flop i oba ti checkaju. Tvoj je raspon i dalje najjači, ali bet sada mora proći kroz dva igrača, a onaj iza prvoga ima više informacija.",
          "Čisti blef od trećine pota treba 25 % foldova obojice zajedno. Ako svaki folda u 60 % slučajeva, oba foldaju tek u 0,6 × 0,6 = 36 %; uz 50 % svaki, točno 25 %. Blefovi trebaju puno više foldanja po igraču nego heads-up.",
          {
            checkpoint: {
              question: "Svaki od dva protivnika folda u 45 % slučajeva. Zarađuje li čisti blef od trećine pota?",
              options: ["Da", "Ne, oba foldaju tek u oko 20 % slučajeva", "Samo na suhim boardovima"],
              answer: 1,
              explain: "0,45 × 0,45 je oko 20 %, manje od 25 % koliko treba blef od trećine pota. Gubi, osim ako ima equity kad dobije call.",
              math: { fn: "allFold", args: [0.45, 2], value: 0.2025 },
              reveal: { id: "multiway", pot: 3, bet: 1, share: 0.45, opponents: 2 },
            },
          },
        ],
      },
      {
        heading: "Što beta",
        blocks: [
          {
            list: [
              "Jake ruke, top par s dobrim kickerom i bolje: u multiway potu dobivaju call od više ruku, pa je value lakši.",
              "Jaki drawovi: imaju fold equity i dosta equityja kad dobiju call.",
              "Ne srednje ruke: s dva igrača za pobijediti srednji par češće je iza i malo dobiva od beta.",
              "Malo čistih blefova, i to s backdoorima ili overkartama za popravak.",
            ],
          },
          "Betaj manje nego heads-up: mali bet gradi pot s tvojim value rukama, a od raspona dvojice igrača ne traži mnogo foldova.",
        ],
      },
      {
        heading: "U Railu",
        blocks: [
          "Flopovi s više igrača nisu u knjižnici flopova, pa tvoje ruke ovdje nose multiway činjenice i oznake analize umjesto ocjene solvera.",
          {
            note: {
              tone: "approximate",
              text: "Railova knjižnica flopova je heads-up. Flopove s više igrača analiza čita heuristikom, s činjenicama i oznakama, ali bez ocjene solvera.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Blef u dvojicu treba da obojica foldaju: pomnoži foldove.",
        "Betaj jake ruke i jake drawove; većinu srednjih ruku checkaj.",
        "Betaj manje nego heads-up.",
      ],
      breaks: [
        "Protiv dva vrlo tijesna igrača koji previše foldaju blefiraj više.",
        "Kad je jedan igrač vrlo kratak, igraj pot kao protiv dubljega.",
      ],
    },
    exercises: {
      "bluff-into-two": "Pet računa: koliko često nekoliko protivnika svi foldaju i koliko svaki mora braniti.",
      "your-hands": "Tvoji multiway flopovi kao preflop raiser, najskuplji prvi.",
    },
    checks: [
      { fn: "allFold", args: [0.6, 2], value: 0.36 },
      { fn: "allFold", args: [0.5, 2], value: 0.25 },
    ],
  },

  "multiway-defence": {
    sections: [
      {
        heading: "Igrači iza tebe",
        blocks: [
          "Suočiti se s betom dok još jedan igrač čeka iza tebe teže je nego zatvoriti akciju. Tvoj call može dobiti raise iza tebe, a ruka koja je ispred igrača koji beta i dalje može biti iza igrača koji još nije odigrao. Zato se brani uže kad netko još može igrati nakon tebe, a šire kad si posljednji.",
          "Obrana je zajednička. Protiv beta od tri četvrtine pota, 3 u 4, alfa je 3 / 7, oko 42,9 %. Dva branitelja koji je dijele jednako brane svaki oko 34,5 %, puno manje od 57,1 % koliko bi trebao jedan branitelj.",
          {
            checkpoint: {
              question: "Bet od tri četvrtine pota ide u dva igrača. Ako obranu dijele jednako, koliko svaki mora braniti?",
              options: ["Oko 21 %", "Oko 34,5 %", "Oko 57 %"],
              answer: 1,
              explain: "Svi foldaju najviše u 3 / 7, oko 42,9 %, slučajeva. Svaki igrač folda najviše drugi korijen od toga, oko 65,5 %, pa svaki brani oko 34,5 %.",
              math: { fn: "mdfSplit", args: [4, 3, 2], value: 0.345 },
              reveal: { id: "multiway", pot: 4, bet: 3, share: 0.345, opponents: 2 },
            },
          },
        ],
      },
      {
        heading: "Lead u polje",
        blocks: [
          "Izvan pozicije u multiway potu lead može imati smisla gdje board snažno pogađa tvoj raspon: niski i povezani boardovi kad si se branio iz blindova. Leadaj s jakim rukama i jakim drawovima, a ostalo checkaj raiseru.",
        ],
      },
      {
        heading: "U Railu",
        blocks: [
          "Tvoje multiway ruke nose multiway činjenice analize: suženi raspon svakog protivnika, tvoj equity protiv polja, podjelu MDF-a i oznake. Računi ispod vježbaju samu podjelu.",
          {
            note: {
              tone: "approximate",
              text: "Railova knjižnica flopova je heads-up. Flopove s više igrača analiza čita heuristikom i podjelom MDF-a, s činjenicama i oznakama, ali bez ocjene solvera.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Brani se uže kad iza tebe još ima igrača na potezu.",
        "Callaj šire kad zatvaraš akciju.",
        "Podijeli obranu: svaki igrač brani manje nego heads-up.",
        "Leadaj samo s jakim rukama i jakim drawovima na boardovima koji pogoduju tvom rasponu.",
      ],
      breaks: [
        "Protiv igrača koji u gomilu beta samo jake ruke foldaj više.",
        "Kad je igrač iza tebe vrlo pasivan, brani se gotovo kao da zatvaraš akciju.",
      ],
    },
    exercises: {
      "mdf-split": "Šest računa: koliko svaki igrač mora braniti protiv betova različitih veličina.",
      "your-hands": "Tvoje multiway odluke protiv beta, na bilo kojem streetu, najskuplje prve.",
    },
    checks: [
      { fn: "alpha", args: [4, 3], value: 0.429 },
      { fn: "mdf", args: [4, 3], value: 0.571 },
    ],
  },
};

import type { LessonBodies } from "./types";

/**
 * M1 — matematika pokera, hrvatski. Ista struktura i isti brojevi kao
 * m1.en.ts; `tests/test/course.test.ts` provjerava i jedno i drugo. Pokerske
 * riječi ostaju one koje koriste hrvatski igrači; čitatelju se obraćamo s „ti”.
 */
export const m1Hr: LessonBodies<
  "pot-odds" | "equity-and-outs" | "expected-value" | "combos-and-card-removal" | "bluffing-math-alpha-mdf" | "equity-realisation-and-implied-odds"
> = {
  "pot-odds": {
    sections: [
      {
        heading: "Pitanje na koje odgovara svaki call",
        blocks: [
          "Kad callaš bet, plaćaš za udio u potu. Call se isplati ako tvoja ruka osvaja taj pot dovoljno često da vrati ono što si uložio. Pot odds to svode na jedan broj: koliko često moraš pobijediti da bi call bio na nuli.",
          "Taj broj ovisi samo o dva iznosa, potu i cijeni. Tvoje karte ga ne zanimaju. Karte odlučuju koliko često stvarno pobjeđuješ; pot odds odlučuju koliko često moraš.",
          {
            checkpoint: {
              question: "Prije ikakve matematike: što određuje koliko equityja call treba?",
              options: ["Tvoje karte", "Veličina beta u odnosu na pot", "Stil protivnika"],
              answer: 1,
              explain:
                "Cijenu određuje samo novac. Karte i read na protivnika govore ti koliko često pobjeđuješ; pot i bet govore koliko često moraš.",
            },
          },
        ],
      },
      {
        heading: "Dva koraka: konačni pot, pa tvoj udio u njemu",
        blocks: [
          "Prvi korak: zbroji pot za koji igraš ako callaš. To je sve što je već u sredini, bet pred kojim si i tvoj call povrh toga. Drugi korak: podijeli svoj call s tim zbrojem. Rezultat je equity koji ti treba.",
          {
            formula: {
              name: "Potreban equity",
              expression: { frac: ["call", "pot prije beta + bet + call"] },
              spoken: "Potreban equity jednak je tvojem callu podijeljenom zbrojem pota prije beta, beta i tvog calla.",
            },
          },
          "Recimo da je pot 30 bb, a protivnik beta 15 bb. Ako callaš, pot postaje 30 + 15 + 15 = 60 bb, a 15 od tih 60 je tvojih. Moraš pobijediti u 15 / 60 = 25 % slučajeva.",
          "Najčešća greška je izostaviti vlastiti call i dijeliti 15 s 45. To daje 33 %, pa svaki call izgleda lošije nego što jest. Call je dio pota koji osvajaš, pa pripada zbroju.",
          {
            checkpoint: {
              question: "Pot je 20 bb, a bet 10 bb. Koliko equityja treba call?",
              options: ["25 %", "33 %", "50 %"],
              answer: 0,
              explain: "Konačni pot je 20 + 10 + 10 = 40 bb, a tvoj call je 10 od toga: 10 / 40 = 25 %. Bet od pola pota uvijek traži četvrtinu.",
              math: { fn: "requiredEquity", args: [30, 10], value: 0.25 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 30, bet: 10, share: 0.25 },
            },
          },
        ],
      },
      {
        heading: "Omjeri bez zamke",
        blocks: [
          "Igrači pot odds često izgovaraju kao omjer: „dobivam 3 prema 1.” To znači da je pot koji možeš osvojiti, prije tvog calla, tri puta veći od calla. U primjeru gore callaš 15 da osvojiš 45 koji su već unutra: 45 prema 15 je 3 prema 1.",
          "Da omjer pretvoriš u potreban equity, zbroji obje strane i uzmi svoju stranu kao udio: 3 prema 1 je 1 od 4, odnosno 25 %. Isti broj, dva zapisa. Postotak je lakše usporediti s tvojim equityjem, zato ga Rail uvijek stavlja prvog.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 45, bet: 15, share: 0.25 },
            caption: "Postavi pot (s betom pred kojim si) i call. Oznaka na traci je equity koji ti treba; pomiči svoj equity preko nje i prati kako EV calla tamo mijenja predznak.",
          },
        ],
      },
      {
        heading: "Veličine koje vrijedi znati napamet",
        blocks: [
          "Budući da je važan samo omjer beta i pota, svaka veličina beta ima stalnu cijenu. Vrijedi ih zapamtiti, jer se javljaju u svakoj sesiji:",
          {
            list: [
              "Četvrtina pota: oko 17 %.",
              "Trećina pota: 20 %.",
              "Pola pota: 25 %.",
              "Dvije trećine pota: oko 29 %.",
              "Tri četvrtine pota: 30 %.",
              "Veličina pota: oko 33 %.",
              "Dvostruki pot: 40 %.",
            ],
          },
          "Primijeti kako cijena sporo raste. Udvostručiš li bet s pola pota na pot, potreban equity pomakne se samo s 25 % na oko 33 %. Male betove jeftino je callati, a ni ogromni nikad ne traže više od pola.",
          {
            checkpoint: {
              question: "Protivnik gurne dvostruki pot. Otprilike koliko često tvoj call mora pobijediti?",
              options: ["Oko 40 %", "Oko 50 %", "Oko 67 %"],
              answer: 0,
              explain: "Uz pot 1, bet je 2, a call 2: konačni pot je 1 + 2 + 2 = 5, a 2 od toga je tvoje. 2 / 5 = 40 %.",
              math: { fn: "requiredEquity", args: [3, 2], value: 0.4 },
            },
          },
        ],
      },
      {
        heading: "Kad cijena nije cijeli odgovor",
        blocks: [
          "Pot odds su točni kad se nakon tvog calla više ništa ne događa: na riveru ili kad je netko all-in. Prije toga može doći još betova, i stvarna se cijena pomiče.",
          {
            list: [
              "Novac koji kasnije možeš osvojiti kad pogodiš čini call boljim nego što cijena kaže. To su implied odds.",
              "Novac koji kasnije možeš izgubiti kad pogodiš drugu najbolju ruku, ili betovi koji te otjeraju s drawa prije nego što dođe, čine ga gorim. To su reverse implied odds.",
              "Svoj equity moraš mjeriti protiv ruku koje stvarno ovako betaju, a ne protiv svih ruku koje protivnik može imati.",
            ],
          },
          "Cijena je dakle početak svakog calla, a ne njegov kraj. Sljedeće lekcije na nju dodaju equity, outove i realizaciju.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Potreban equity = call ÷ (pot prije beta + bet + call). Tvoj call je uvijek u zbroju.",
        "Pola pota traži 25 %, pot oko 33 %, dvostruki pot 40 %.",
        "Cijenu uspoređuj sa svojim equityjem protiv raspona koji beta, a ne protiv nasumične ruke.",
      ],
      breaks: [
        "Dok dolaze još karte, novi betovi mijenjaju stvarnu cijenu u oba smjera: implied i reverse implied odds.",
        "Protiv igrača koji gotovo nikad ne blefiraju velikim betom tvoj je stvarni equity manji nego što chart raspona sugerira, pa sama cijena precjenjuje call.",
      ],
    },
    exercises: {
      "price-drill":
        "Deset situacija s potom i betom. Izračunaj equity koji call treba prije nego što ga kalkulator pokaže. Odgovor unutar jednog i pol postotnog boda se priznaje.",
      "your-hands":
        "Tvoje odluke u kojima je analiza označila call bez cijene ili fold uz nju, najskuplje prve. Odluči prije nego što vidiš što si napravio.",
    },
    checks: [
      { fn: "requiredEquity", args: [45, 15], value: 0.25 },
      { fn: "ratio", args: [15, 45], value: 0.333 },
      { fn: "potOddsRatio", args: [45, 15], value: 3 },
      { fn: "requiredEquity", args: [1.25, 0.25], value: 0.167 },
      { fn: "requiredEquity", args: [1.333333, 0.333333], value: 0.2 },
      { fn: "requiredEquity", args: [1.5, 0.5], value: 0.25 },
      { fn: "requiredEquity", args: [1.666667, 0.666667], value: 0.286, tolerance: 0.006 },
      { fn: "requiredEquity", args: [1.75, 0.75], value: 0.3 },
      { fn: "requiredEquity", args: [2, 1], value: 0.333 },
      { fn: "requiredEquity", args: [3, 2], value: 0.4 },
    ],
  },

  "equity-and-outs": {
    sections: [
      {
        heading: "Equity: tvoj udio kad bi se karte podijelile odmah",
        blocks: [
          "Tvoj equity je udio pota koji bi tvoja ruka u prosjeku osvojila kad bi se sve preostale karte podijelile odmah, bez daljnjeg betanja. Izjednačenje se broji kao pola pobjede.",
          "Protiv raspona to je prosjek preko svake kombinacije koju protivnik može imati. Pot odds ti govore koliko equityja call treba; ova lekcija govori kako brzo i bez računala procijeniti koliko ga imaš.",
          {
            widget: { id: "equity", focus: "range", hand: ["9h", "8h"], preset: "open-btn" },
            caption: "Odaberi ruku i protivnikov raspon, a zatim dodaj flop. Stavi na njega dva herca i usporedi equity drawa s onim što na istom boardu ima par.",
          },
        ],
      },
      {
        heading: "Brojanje outova",
        blocks: [
          "Out je karta koju ne vidiš, a koja bi ti trebala dati najbolju ruku. Većina drawova ima nekoliko standardnih oblika, i za svaki vrijedi znati broj:",
          {
            list: [
              "Flush draw: boja ima 13 karata, a vidiš ih 4, dvije u ruci i dvije na boardu. 13 − 4 = 9 outova.",
              "Open-ended straight draw: četiri karte ga zatvaraju na svakom kraju. 4 × 2 = 8 outova.",
              "Gutshot: jedna vrijednost, četiri karte. 4 outa.",
              "Dvije overkarte: od svake vrijednosti ostale su tri. 3 × 2 = 6 outova, ali samo ako te par stvarno stavlja ispred.",
            ],
          },
          "Kad imaš dva drawa odjednom, ne broji kartu dvaput. Flush draw s open-ended straight drawom ima 9 karata za boju i 8 za skalu, ali dvije karte za skalu su u tvojoj boji i već su prebrojane.",
          {
            checkpoint: {
              question: "Imaš flush draw i open-ended straight draw. Koliko outova?",
              options: ["17", "15", "13"],
              answer: 1,
              explain: "9 karata za boju plus 8 za skalu, minus 2 karte za skalu koje su i u tvojoj boji: 9 + 8 − 2 = 15.",
              math: { fn: "sum", args: [9, 8, -2], value: 15 },
            },
          },
        ],
      },
      {
        heading: "Prljavi outovi",
        blocks: [
          "Neki outovi zatvore tvoj draw, a ti svejedno izgubiš. Prije nego što prebrojiš kartu, zapitaj se što ona radi rukama koje protivnik vjerojatno ima.",
          {
            list: [
              "Karta za boju koja upari board može setu dati full house.",
              "Karta za skalu koja na board stavi treću ili četvrtu kartu iste boje može nekome drugome dati flush.",
              "Outovi s overkartama malo vrijede protiv dva para ili seta, jer ti par s tvojom kartom ne donosi pobjedu.",
            ],
          },
          "Takve karte broji kao pola outa ili ih izostavi, ovisno o tome koliko je vjerojatna ruka koja te pobjeđuje. Gruba korekcija bolja je od preciznog brojanja pogrešne stvari.",
        ],
      },
      {
        heading: "Od outova do equityja: ×2 i ×4",
        blocks: [
          "Na flopu vidiš pet karata, pa ih 52 − 5 = 47 ne vidiš. S 9 outova turn pogađa u 9 / 47 slučajeva, oko 19,1 %. Na turnu ne vidiš 46 karata, a river pogađa u 9 / 46, oko 19,6 %.",
          "Kad dolaze obje karte, lakše je brojati promašaje. Turn promašuješ s 38 od 47 karata, a zatim river s 37 od 46: 38 × 37 = 1.406 od 47 × 46 = 2.162 runouta, oko 0,65. Pogađaš dakle u oko 35 % slučajeva.",
          "To nitko ne radi za stolom. Prečac: pomnoži outove s 2 za svaku kartu koja dolazi. Jedna karta: 9 × 2 = 18 %. Dvije karte: 9 × 4 = 36 %. Oba broja padnu unutar boda ili dva od točnih, što je dovoljno blizu za odluku.",
          "Pravilo ×4 pretjeruje s velikim drawovima. S 15 outova kaže 15 × 4 = 60 %, ali točna šansa promašaja je 32 × 31 = 992 od 2.162, oko 0,459, pa pogađaš u oko 54 % slučajeva. S više od otprilike 8 outova oduzmi nekoliko bodova.",
          {
            checkpoint: {
              question: "Na turnu imaš open-ended straight draw, 8 čistih outova. Otprilike koliki je tvoj equity za river?",
              options: ["Oko 8 %", "Oko 16 %", "Oko 32 %"],
              answer: 1,
              explain: "Dolazi jedna karta, dakle ×2: 8 × 2 = 16 %. Točan broj je 8 / 46, malo viši.",
              math: { fn: "product", args: [8, 2], value: 16 },
            },
          },
        ],
      },
      {
        heading: "Zanemaruje li ×4 sljedeći bet?",
        blocks: [
          "Da, i to je ono što treba zapamtiti. Broj ×4 tvoj je equity ako turn i river vidiš za cijenu jednog calla. To se događa samo kad je netko all-in ili kad si siguran da će turn proći u checkovima.",
          "Recimo da je pot 20 bb, a protivnik na flopu beta 10 bb. Konačni pot je 20 + 10 + 10 = 40 bb, pa call treba 10 / 40 = 25 %. S flush drawom ×4 kaže 36 %, udoban call. Ali ako na turnu, kad promašiš, dolazi drugi bet, tvoj call kupuje samo jednu kartu, a ×2 kaže 18 %: manje od cijene.",
          "Zato ×4 koristi kad više nema novca koji može ući, a ×2 kad ima. Razliku između njih mora platiti ono što kasnije osvojiš kad pogodiš. To su implied odds, tema posljednje lekcije ovog modula.",
          {
            checkpoint: {
              question: "Protivnik ide all-in na flopu, a ti imaš flush draw. Koja procjena vrijedi?",
              options: ["×2: karta po karta", "×4: vidjet ćeš i turn i river"],
              answer: 1,
              explain: "Nitko više ne može betati, pa tvoj call kupuje obje karte. Ovdje je ×4 prava procjena, a pot odds su točni.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Flush draw 9 outova, open-ended 8, gutshot 4, dvije overkarte do 6.",
        "Outovi × 2 za svaku kartu koja dolazi: ×2 kad ostaje jedna, ×4 kad ostaju dvije.",
        "×4 koristi samo kad više nema betanja; inače koristi ×2, a ostatak računaj kao implied odds.",
        "Umanji outove koji poboljšavaju i ruke koje te vjerojatno pobjeđuju.",
      ],
      breaks: [
        "×4 precjenjuje velike drawove: s više od otprilike 8 outova oduzmi nekoliko bodova.",
        "Outovi pretpostavljaju da znaš protiv čega igraš. Protiv raspona neki su tvoji outovi čisti protiv jedne ruke, a mrtvi protiv druge.",
      ],
    },
    exercises: {
      "draw-equity":
        "Šest flopova s drawom protiv gotove ruke. Procijeni equity drawa do rivera; unutar pet postotnih bodova se priznaje. Rail zatim pokazuje točan broj preko svakog turna i rivera, outove protiv te ruke te procjene ×2 i ×4.",
      "your-hands":
        "Tvoji callovi na flopu i turnu koje je analiza označila kao call bez cijene, najskuplji prvi. Prebroji outove prije nego što vidiš što si napravio.",
    },
    checks: [
      { fn: "sum", args: [13, -4], value: 9 },
      { fn: "product", args: [4, 2], value: 8 },
      { fn: "product", args: [3, 2], value: 6 },
      { fn: "sum", args: [52, -5], value: 47 },
      { fn: "ratio", args: [9, 47], value: 0.191 },
      { fn: "sum", args: [52, -6], value: 46 },
      { fn: "ratio", args: [9, 46], value: 0.196 },
      { fn: "sum", args: [47, -9], value: 38 },
      { fn: "product", args: [38, 37], value: 1406 },
      { fn: "product", args: [47, 46], value: 2162 },
      { fn: "ratio", args: [1406, 2162], value: 0.65 },
      { fn: "sum", args: [1, -0.65], value: 0.35 },
      { fn: "product", args: [9, 2], value: 18 },
      { fn: "product", args: [9, 4], value: 36 },
      { fn: "product", args: [15, 4], value: 60 },
      { fn: "sum", args: [47, -15], value: 32 },
      { fn: "product", args: [32, 31], value: 992 },
      { fn: "ratio", args: [992, 2162], value: 0.459 },
      { fn: "sum", args: [1, -0.459], value: 0.541 },
      { fn: "sum", args: [20, 10, 10], value: 40 },
      { fn: "requiredEquity", args: [30, 10], value: 0.25 },
    ],
  },

  "expected-value": {
    sections: [
      {
        heading: "Prosjek preko svega što se može dogoditi",
        blocks: [
          "Očekivana vrijednost je ono što odluka u prosjeku osvaja ili gubi, kad bi je mogao donijeti mnogo puta. Uzmi svaki način na koji ruka može otići, pomnoži koliko on donosi s tim koliko se često događa i zbroji rezultate.",
          {
            formula: {
              name: "EV",
              expression: ["Σ (vjerojatnost × ishod)"],
              spoken: "EV je jednak zbroju, preko svih ishoda, vjerojatnosti puta ishod.",
              where: [["ishod", "koliko od ovog trenutka osvajaš ili gubiš, u big blindovima"]],
            },
          },
          "Računaj od mjesta gdje sada stojiš. Žetoni koje si uložio ranije dio su pota, a ne tvoji, pa fold uvijek vrijedi točno 0. Svaka druga opcija mjeri se u odnosu na to.",
        ],
      },
      {
        heading: "EV calla",
        blocks: [
          "Na riveru je pot 20 bb, a protivnik beta 10 bb. Misliš da tvoja ruka pobjeđuje u 30 % slučajeva. Call ima dva ishoda: u 30 % slučajeva osvajaš 30 bb iz sredine, a u 70 % gubiš svojih 10 bb.",
          "EV = 0,3 × 30 − 0,7 × 10 = 9 − 7 = +2 bb. Prečac iz pot oddsa daje isti odgovor u jednom retku: equity × konačni pot − call = 0,3 × 40 − 10 = 12 − 10 = +2 bb.",
          {
            checkpoint: {
              question: "Isti bet, ali sada pobjeđuješ u samo 20 % slučajeva. Koliko vrijedi call?",
              options: ["+2 bb", "0 bb", "−2 bb"],
              answer: 2,
              explain: "0,2 × 40 − 10 = 8 − 10 = −2 bb. Call treba 25 % da bude na nuli, a 20 % nije dovoljno, pa je fold (koji vrijedi 0) bolji.",
              math: { fn: "callEv", args: [30, 10, 0.2], value: -2 },
            },
          },
        ],
      },
      {
        heading: "Betovi koji dobivaju na dva načina",
        blocks: [
          "Bet dobiva na dva načina: protivnik folda i ti odmah uzimaš pot, ili calla i ti igraš dalje sa svojim equityjem. Njegov EV zbraja te dvije grane.",
          {
            formula: {
              name: "EV beta",
              expression: ["udio foldova × pot + udio callova × EV kad je callan"],
              spoken: "EV beta jednak je tome koliko često protivnik folda puta pot, plus koliko često calla puta EV beta kad je callan.",
            },
          },
          "Na turnu je pot 20 bb, a ti s drawom betaš 10 bb. Recimo da protivnik folda u 40 % slučajeva, a kad calla, imaš 25 % equityja bez daljnjeg betanja. Kad je callan, bet vrijedi 0,25 × 40 − 10 = 0. Bet dakle vrijedi 0,4 × 20 + 0,6 × 0 = +8 bb.",
          "Sada neka to bude čisti blef koji nikad ne pobjeđuje kad je callan. Grana s callom košta 10 bb: 0,4 × 20 − 0,6 × 10 = 8 − 6 = +2 bb. Equity drawa ovdje vrijedi 8 − 2 = 6 bb.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 20, bet: 10, share: 0.4 },
            caption: "Pogled čistog blefa: pot prije tvog beta, bet i koliko često protivnik folda. Na nuli je uz 10 / 30, oko 33 % foldova; uz 40 % blef vrijedi +2 bb.",
          },
          {
            checkpoint: {
              question: "Isti pot i bet, ali protivnik folda samo u 30 % slučajeva. Koliko vrijedi čisti blef?",
              options: ["+6 bb", "−1 bb", "−7 bb"],
              answer: 1,
              explain:
                "0,3 × 20 − 0,7 × 10 = 6 − 7 = −1 bb: ispod 33 % koliko treba. S 25 % equityja drawa grana s callom vrijedi 0 umjesto −10, pa bet zarađuje 0,3 × 20 = +6 bb.",
              math: { fn: "bluffEv", args: [20, 10, 0.3], value: -1 },
            },
          },
        ],
      },
      {
        heading: "Cilj nije osvajati potove",
        blocks: [
          "Call od +2 bb gore gubi 7 puta od 10. Igrač koji calla samo kad je ispred osvaja više potova koje igra, a manje novca. Blef koji prolazi u 40 % slučajeva češće gubi nego što dobiva, a svejedno zarađuje.",
          "Zato EV broji u big blindovima, nikad u osvojenim potovima. Mnoge od najboljih poteza u pokeru većinu vremena gube; samo kad uspiju, donose više nego što gube.",
        ],
      },
      {
        heading: "Gubitak EV-a: razlika do najbolje opcije",
        blocks: [
          "Svaka opcija u situaciji ima EV, a najbolja postavlja letvicu. Railov gubitak EV-a je EV najbolje opcije minus EV one koju si odabrao. U river situaciji s 30 % call vrijedi +2 bb, a fold 0, pa fold gubi 2 bb. Uz 20 % najbolji je fold, a call gubi 2 bb.",
          "Dvije Railove provjere čista su logika EV-a. Fold kad možeš besplatno checkati uvijek gubi, jer check zadržava tvoj udio u potu bez ikakvog troška. A fold najjače moguće ruke odriče se svega što bi osvojila.",
          {
            widget: { id: "grading" },
            caption: "Svakoj opciji daj EV i prati kako se gubitak EV-a tvog izbora pretvara u ocjenu.",
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "EV = zbroj vjerojatnost × ishod preko svih ishoda, računato od sada.",
        "Fold vrijedi 0; svaka druga opcija mjeri se u odnosu na njega.",
        "EV beta = udio foldova × pot + udio callova × EV kad je callan.",
        "Poteze sudi po EV-u u big blindovima, a ne po tome koliko često osvajaju pot.",
      ],
      breaks: [
        "Ova stabla pretpostavljaju da nakon calla nema betanja. Kad dolaze još streetovi, ono što se događa kasnije mijenja EV grane s callom u oba smjera.",
        "Ulazni podaci su procjene. Stablo sagrađeno na krivoj stopi foldova ili krivom equityju daje krivi odgovor koji izgleda precizno.",
      ],
    },
    exercises: {
      "ev-trees":
        "Šest semi-blefova: pot, tvoj bet, koliko često protivnik folda i tvoj equity kad je callan. Izračunaj EV beta kao udio foldova × pot + udio callova × EV kad je callan, uz pretpostavku da nakon calla nema betanja; unutar četvrtine big blinda ili 8 % odgovora se priznaje.",
      "river-ev":
        "Tri river situacije iz Railova solvera. Odaberi akciju, a zatim pročitaj EV svake opcije i gubitak EV-a svoje.",
    },
    checks: [
      { fn: "product", args: [0.3, 30], value: 9 },
      { fn: "product", args: [0.7, 10], value: 7 },
      { fn: "sum", args: [9, -7], value: 2 },
      { fn: "sum", args: [20, 10, 10], value: 40 },
      { fn: "product", args: [0.3, 40], value: 12 },
      { fn: "callEv", args: [30, 10, 0.3], value: 2 },
      { fn: "product", args: [0.2, 40], value: 8 },
      { fn: "requiredEquity", args: [30, 10], value: 0.25 },
      { fn: "callEv", args: [30, 10, 0.25], value: 0, tolerance: 0.001 },
      { fn: "product", args: [0.4, 20], value: 8 },
      { fn: "product", args: [0.6, 10], value: 6 },
      { fn: "bluffEv", args: [20, 10, 0.4], value: 2 },
      { fn: "sum", args: [8, -2], value: 6 },
      { fn: "alpha", args: [20, 10], value: 0.333 },
      { fn: "product", args: [0.3, 20], value: 6 },
      { fn: "sum", args: [6, -7], value: -1 },
    ],
  },

  "combos-and-card-removal": {
    sections: [
      {
        heading: "Nisu sve ruke jednako vjerojatne",
        blocks: [
          "Raspon se zapisuje klasama ruku, AA ili AK, ali klase nisu jednako vjerojatne. Neke se mogu podijeliti na više načina od drugih. Svaki pojedini način, poput A♠K♥, jedna je kombinacija, a brojanje kombinacija način je da jedan dio raspona odvagneš prema drugome.",
        ],
      },
      {
        heading: "Šest, četiri, dvanaest",
        blocks: [
          "Tri broja pokrivaju svaku početnu ruku:",
          {
            list: [
              "Par: četiri karte te vrijednosti i bilo koje dvije od njih. 4 × 3 = 12 uređenih parova, a svaki je brojan dvaput, pa je 12 / 2 = 6 kombinacija.",
              "Suited ruka: jedna po boji, dakle 4 kombinacije.",
              "Offsuit ruka: 4 × 4 = 16 načina da se upare dvije vrijednosti, minus 4 suited: 16 − 4 = 12 kombinacija.",
            ],
          },
          "Nesparena ruka poput AK zato ima 4 + 12 = 16 kombinacija, naspram 6 za par. U rasponu od AA, KK i AK, AK čini 16 od 6 + 6 + 16 = 28 kombinacija: više od polovice.",
          {
            checkpoint: {
              question: "Koliko ukupno ima kombinacija AK, suited i offsuit zajedno?",
              options: ["4", "12", "16"],
              answer: 2,
              explain: "Bilo koji od 4 asa s bilo kojim od 4 kralja: 4 × 4 = 16, od čega su 4 suited, a 12 offsuit.",
              math: { fn: "product", args: [4, 4], value: 16 },
            },
          },
        ],
      },
      {
        heading: "Uklanjanje karata",
        blocks: [
          "Karta koju vidiš, na boardu ili u svojoj ruci, ne može biti u protivnikovoj ruci. Svaka karta koju vidiš uklanja kombinacije.",
          "Za par prebroji koliko je karata te vrijednosti ostalo. Kad vidiš jednu, ostale su 3: 3 × 2 = 6, prepolovljeno, daje 3 kombinacije. Kad vidiš dvije, ostale su 2: 2 × 1 = 2, prepolovljeno, daje 1 kombinaciju. Za nesparenu ruku pomnoži preostale karte svake vrijednosti: kad vidiš jednog asa, AK ima 3 × 4 = 12 kombinacija.",
          "Na K♦7♣2♥ svaki set ima još 3 kombinacije, pa je ukupno 3 + 3 + 3 = 9 setova.",
          {
            widget: { id: "combos", hand: ["Ah", "Qd"], preset: "sets-k72" },
            caption: "Stavi K♦7♣2♥ na board i tri seta padnu sa 6 kombinacija na 3. Zatim stavi kralja u svoju ruku i gledaj kako KK opet pada.",
          },
          {
            checkpoint: {
              question: "Board je K♦7♣2♥, a ti imaš A♠K♠. Koliko kombinacija AK protivnik može imati?",
              options: ["6", "9", "12"],
              answer: 0,
              explain: "Ostala su tri asa (jednog držiš) i dva kralja (jedan je u tvojoj ruci, jedan na boardu): 3 × 2 = 6 kombinacija.",
              math: { fn: "product", args: [3, 2], value: 6 },
            },
          },
        ],
      },
      {
        heading: "Koliko često blefira? Prebroji dvije skupine",
        blocks: [
          "Brojanje cijelog raspona djeluje nesavladivo, a rijetko ti treba. Kad protivnik beta, razvrstaj njegove vjerojatne ruke u dvije skupine, value i blefove, i svaku grubo prebroji.",
          "Recimo da njegove value ruke imaju 18 kombinacija, a blefovi 6. Tada je 6 od njegovih 18 + 6 = 24 kombinacije koje betaju blef: 6 / 24 = 25 %. Ako je betao pola pota, tvoj call treba 25 %, pa je ruka koja pobjeđuje samo njegove blefove na nuli.",
          {
            checkpoint: {
              question:
                "Imaš ruku koja pobjeđuje njegove blefove i ništa drugo. Beta veličinu pota, pa ti treba oko 33 %. Brojiš 20 value kombinacija i 5 blefova. Call ili fold?",
              options: ["Call: pet blefova je dovoljno", "Fold: blefovi su samo 20 % njegovih betova"],
              answer: 1,
              explain: "Blef je 5 od 25 kombinacija: 5 / 25 = 20 %, manje od 33 % koliko traži cijena. Foldaj, osim ako imaš razloga misliti da blefira više nego što si prebrojao.",
              math: { fn: "ratio", args: [5, 25], value: 0.2 },
            },
          },
        ],
      },
      {
        heading: "Vrata prema blockerima",
        blocks: [
          "Tvoje karte mijenjaju te brojeve. Držiš li kartu koja treba njegovim value rukama, broj value kombinacija pada, a udio blefova raste; držiš li kartu koja treba njegovim blefovima, događa se suprotno.",
          "Brojanjem mjeriš taj učinak. Na K♦7♣2♥ kralj u tvojoj ruci smanjuje KK s 3 kombinacije na 1, odnosno uklanja ih 3 − 1 = 2. To je ideja blockera, na kojoj gradi modul o rasponima.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Par ima 6 kombinacija, suited ruka 4, offsuit ruka 12, a nesparena ruka ukupno 16.",
        "Svaka karta koju vidiš uklanja kombinacije: pomnoži preostale karte svake vrijednosti.",
        "Da vidiš koliko često blefira, prebroji dvije skupine, value i blefove, i usporedi udio blefova sa svojom cijenom.",
      ],
      breaks: [
        "Kombinacije broje samo ono što je moguće. Stvarni igrači ne igraju svaku moguću kombinaciju jednako, pa je brojanje dobro koliko i raspon iza njega.",
        "Grubo brojanje dovoljno je za odluke, ali jedna uklonjena karta najviše znači kad su skupine male.",
      ],
    },
    exercises: {
      "count-combos":
        "Osam boardova s podijeljenom tvojom rukom i rukom za brojanje: par, suited ruka ili ruka suited i offsuit zajedno. Prebroji kombinacije koje protivnik još može imati nakon što ukloniš board i svoje karte; priznaje se samo točan broj.",
    },
    checks: [
      { fn: "product", args: [4, 3], value: 12 },
      { fn: "ratio", args: [12, 2], value: 6 },
      { fn: "product", args: [4, 4], value: 16 },
      { fn: "sum", args: [16, -4], value: 12 },
      { fn: "sum", args: [4, 12], value: 16 },
      { fn: "sum", args: [6, 6, 16], value: 28 },
      { fn: "product", args: [3, 2], value: 6 },
      { fn: "ratio", args: [6, 2], value: 3 },
      { fn: "product", args: [2, 1], value: 2 },
      { fn: "ratio", args: [2, 2], value: 1 },
      { fn: "product", args: [3, 4], value: 12 },
      { fn: "sum", args: [3, 3, 3], value: 9 },
      { fn: "sum", args: [18, 6], value: 24 },
      { fn: "ratio", args: [6, 24], value: 0.25 },
      { fn: "requiredEquity", args: [1.5, 0.5], value: 0.25 },
      { fn: "requiredEquity", args: [2, 1], value: 0.333 },
      { fn: "sum", args: [20, 5], value: 25 },
      { fn: "sum", args: [3, -1], value: 2 },
    ],
  },

  "bluffing-math-alpha-mdf": {
    sections: [
      {
        heading: "Koliko često blef mora proći",
        blocks: [
          "Čisti blef osvaja pot kad protivnik folda, a gubi bet kad calla. Na nuli je kad se te dvije strane izjednače, a ta stopa foldova ima ime: alpha.",
          {
            formula: {
              name: "Alpha",
              expression: { frac: ["bet", "pot + bet"] },
              spoken: "Alpha je jednaka betu podijeljenom zbrojem pota i beta.",
              where: [["pot", "pot prije tvog beta"]],
            },
          },
          "Betaš li 10 bb u 20 bb, riskiraš 10 da osvojiš 20: blef treba foldove u 10 / 30 slučajeva, oko 33 %. Ako protivnik folda više, bilo koje dvije karte profitiraju od beta; ako folda manje, čisti blef gubi.",
          {
            checkpoint: {
              question: "Betaš veličinu pota kao čisti blef. Koliko često protivnik mora foldati?",
              options: ["33 %", "50 %", "67 %"],
              answer: 1,
              explain: "Uz pot 1 riskiraš 1 da osvojiš 1: 1 / (1 + 1) = 50 %.",
              math: { fn: "alpha", args: [1, 1], value: 0.5 },
            },
          },
        ],
      },
      {
        heading: "Strana branitelja: MDF",
        blocks: [
          "Okreni to. Ako foldaš češće od alphe, protivnik može betati bilo koje dvije karte i profitirati. Da to spriječi, branitelj mora nastaviti, callom ili raiseom, s barem ostatkom raspona: to je minimalna frekvencija obrane.",
          {
            formula: {
              name: "MDF",
              expression: ["1 − alpha = ", { frac: ["pot", "pot + bet"] }],
              spoken: "MDF je jednak jedan minus alpha, odnosno potu podijeljenom zbrojem pota i beta.",
            },
          },
          "Protiv beta od pola pota, 10 bb u 20 bb, MDF je 20 / 30, oko 67 %. To nije cijena calla: call treba 25 % equityja, kako je pokazala lekcija o pot oddsima. Alpha i MDF odgovaraju na „koliko često”, a pot odds na „s čime”.",
          {
            widget: { id: "bet-math", focus: "mdf", pot: 20, bet: 10 },
            caption: "Postavi pot prije beta i bet. Alpha i MDF uvijek zajedno daju 100 %; prati kako se oba mijenjaju dok bet raste.",
          },
        ],
      },
      {
        heading: "Veličine koje vrijedi znati",
        blocks: [
          "Kao i pot odds, alpha i MDF ovise samo o betu kao udjelu pota:",
          {
            list: [
              "Trećina pota: alpha 25 %, MDF 75 %.",
              "Pola pota: alpha oko 33 %, MDF oko 67 %.",
              "Dvije trećine pota: alpha 40 %, MDF 60 %.",
              "Veličina pota: alpha 50 %, MDF 50 %.",
              "Dvostruki pot: alpha oko 67 %, MDF oko 33 %.",
            ],
          },
          {
            checkpoint: {
              question: "Protivnik beta tri četvrtine pota. Otprilike koliki dio tvog raspona mora nastaviti?",
              options: ["Oko 43 %", "Oko 57 %", "Oko 75 %"],
              answer: 1,
              explain: "Uz pot 4 i bet 3, MDF je 4 / (4 + 3) = 4 / 7, oko 57 %. Alpha je preostalih 43 %.",
              math: { fn: "mdf", args: [4, 3], value: 0.571 },
            },
          },
        ],
      },
      {
        heading: "Koliko blefova betati",
        blocks: [
          "Sa strane onoga koji beta, pitanje je koliko blefova staviti uz value betove na riveru. Uz pravi omjer ruka koja pobjeđuje samo blefove ništa ne dobiva ni callom ni foldom. Taj udio blefova jednak je betu podijeljenom zbrojem pota i dvostrukog beta.",
          "Za bet veličine pota to je 1 / (1 + 2), oko 33 %: jedan blef na svake dvije value ruke. Za bet od pola pota 10 / (20 + 20) = 25 %: jedan blef na svake tri.",
          "Ako ti se čini da blefiraš previše, prebroji. Najprije zbroji svoje value kombinacije, brojanjem iz prošle lekcije, a zatim dodaj blefove u tom omjeru. Protiv igrača koji previše callaju, dodaj ih manje.",
        ],
      },
      {
        heading: "Gdje polazne brojke prestaju vrijediti",
        blocks: [
          "Alpha i MDF točni su samo za čiste blefove na riveru, protiv protivnika o kojem ništa ne znaš. Svugdje drugdje su smjernice.",
          {
            list: [
              "Prije rivera blefovi imaju equity, pa trebaju manje foldova, a ruke koje brane mogu kasnije biti otjerane.",
              "Protiv igrača koji rijetko blefira velikim betom obrana do MDF-a samo isplaćuje value. Foldaj više.",
              "Protiv igrača koji previše blefira brani više od MDF-a.",
              "MDF zajedno broji callove i raiseove, a kad je u ruci više igrača, obranu dijele među sobom.",
            ],
          },
          {
            checkpoint: {
              question: "Igrač koji gotovo nikad ne blefira na riveru beta pot. Imaš ruku koja pobjeđuje samo blefove. Što ti MDF govori da napraviš?",
              options: ["Brani 50 % raspona, kako kaže MDF", "Foldaj više nego što kaže MDF"],
              answer: 1,
              explain:
                "MDF te štiti od protivnika koji bi mogao blefirati bilo koje dvije karte. Ovaj to ne radi, pa call „da ga držiš poštenim” samo isplaćuje njegove value betove.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Alpha = bet ÷ (pot + bet): koliko često čisti blef mora proći.",
        "MDF = pot ÷ (pot + bet): koliki dio raspona mora nastaviti protiv beta.",
        "Pola pota: alpha oko 33 %, MDF oko 67 %. Pot: po 50 %.",
        "Na riveru blefiraj u omjeru bet ÷ (pot + 2 × bet) svojih betova.",
      ],
      breaks: [
        "Protiv igrača koji premalo blefiraju foldaj više od MDF-a; protiv onih koji blefiraju previše brani više.",
        "Prije rivera obje strane imaju equity koji tek dolazi, pa su brojke polazište, a ne odgovor.",
      ],
    },
    exercises: {
      "sizing-quiz":
        "Osam veličina beta, zadanih kao udio pota. Za svaku daj alphu (koliko često čisti blef mora proći) ili MDF (koliki dio raspona mora nastaviti), kako pitanje traži; unutar jednog i pol postotnog boda se priznaje.",
      "your-hands":
        "Tvoji foldovi na riveru koje je analiza označila kao fold uz cijenu, najskuplji prvi. Odluči prije nego što vidiš što si napravio.",
    },
    checks: [
      { fn: "alpha", args: [20, 10], value: 0.333 },
      { fn: "mdf", args: [20, 10], value: 0.667 },
      { fn: "requiredEquity", args: [30, 10], value: 0.25 },
      { fn: "alpha", args: [3, 1], value: 0.25 },
      { fn: "mdf", args: [3, 1], value: 0.75 },
      { fn: "alpha", args: [2, 1], value: 0.333 },
      { fn: "mdf", args: [2, 1], value: 0.667 },
      { fn: "alpha", args: [3, 2], value: 0.4 },
      { fn: "mdf", args: [3, 2], value: 0.6 },
      { fn: "mdf", args: [1, 1], value: 0.5 },
      { fn: "alpha", args: [1, 2], value: 0.667 },
      { fn: "mdf", args: [1, 2], value: 0.333 },
      { fn: "alpha", args: [4, 3], value: 0.429 },
      { fn: "bluffShare", args: [1, 1], value: 0.333 },
      { fn: "product", args: [2, 10], value: 20 },
      { fn: "bluffShare", args: [20, 10], value: 0.25 },
    ],
  },

  "equity-realisation-and-implied-odds": {
    sections: [
      {
        heading: "Equity pretpostavlja besplatnu vožnju",
        blocks: [
          "Sirovi equity pretpostavlja da se sve karte podijele bez daljnjeg betanja. Prave ruke to ne dobivaju. Na kasnijim streetovima dolaze betovi, a neki te otjeraju s ruke koja bi pobijedila ili te natjeraju da platiš karte koje ti trebaju.",
          "Realizacija equityja udio je sirovog equityja koji stvarno pretvoriš u udio u potu kad se betanje odigra do kraja. Ruka s 40 % equityja koja realizira 80 % od toga u novcu se ponaša kao ruka s 0,4 × 0,8 = 32 %.",
          {
            formula: {
              name: "Realizirani equity",
              expression: ["equity × R"],
              spoken: "Realizirani equity jednak je sirovom equityju pomnoženom s R, faktorom realizacije.",
              where: [["R", "udio equityja koji ruka pretvara u udio u potu; iznad 1 kad osvaja više od svog udjela"]],
            },
          },
        ],
      },
      {
        heading: "Što ruci pomaže da realizira",
        blocks: [
          "Isti sirovi equity može vrijediti vrlo različito, ovisno o tome koliko je ruku lako igrati:",
          {
            list: [
              "Pozicija: kad igraš zadnji, prvo vidiš što protivnik radi i možeš uzeti besplatnu kartu ili betati kad pokaže slabost.",
              "Igrivost: suited i povezane ruke slažu jake ruke s kojima je lako nastaviti; offsuit ruke sa slabim kickerom uglavnom slažu jedan par koji je često drugi najbolji.",
              "Inicijativa: igrač koji je zadnji betao često može osvojiti pot betom kad nitko nema puno.",
              "Dubina stackova: dublji stackovi znače više betova pred tobom, što šteti rukama koje ne podnose pritisak.",
            ],
          },
          {
            widget: { id: "equity", focus: "realisation", hand: ["Js", "9s"], preset: "open-btn", share: 0.9 },
            caption: "Tvoja ruka protiv raspona otvaranja s buttona. Pomiči faktor realizacije i gledaj gdje realizirani equity prelazi cijenu. Zatim usporedi s offsuit rukom i nižim faktorom.",
          },
          {
            checkpoint: {
              question: "Dvije ruke imaju isti sirovi equity protiv opena. Jedna je suited i povezana, druga offsuit sa slabim kickerom. Izvan pozicije, koja je bolja obrana?",
              options: ["Suited, povezana ruka", "Offsuit ruka", "Iste su: equity je equity"],
              answer: 0,
              explain:
                "Suited, povezana ruka slaže skale, boje i dva para s kojima može nastaviti betati, pa realizira više svog equityja. Offsuit ruka uglavnom slaže slabe parove koje mora foldati na kasnije betove.",
            },
          },
        ],
      },
      {
        heading: "Big blind protiv buttona",
        blocks: [
          "Button otvara na 2,5 bb, a small blind folda. U potu je 2,5 + 0,5 + 1 = 4 bb, a big blind calla još 1,5 bb: treba mu 1,5 / 5,5, oko 27,3 %. To je odlična cijena, pa big blind brani široko.",
          "Ali ostatak ruke igra izvan pozicije, pa realizira manje od svog sirovog equityja. Ruke koje udobno prelaze cijenu i dobro se igraju brane; ruke koje je prelaze samo na papiru, uglavnom offsuit i lako dominirane, ne brane.",
          {
            checkpoint: {
              question:
                "Ruka ima 35 % sirovog equityja protiv opena s buttona i, za primjer, izvan pozicije realizira 70 % od toga. Prelazi li cijenu od 27,3 %?",
              options: ["Da, lako", "Ne: realizira oko 24,5 %"],
              answer: 1,
              explain: "0,35 × 0,7 = 0,245, dakle oko 24,5 %, ispod 27,3 % koliko call treba. Po sirovom equityju izgledala je kao call; kad se uračuna realizacija, to je fold.",
              math: { fn: "product", args: [0.35, 0.7], value: 0.245 },
            },
          },
          "Faktori realizacije u ovoj lekciji su ilustracije, a ne riješeni brojevi. Railovi preflop chartovi već uključuju realizaciju; vježba ispod pokazuje gdje to stavlja granične ruke.",
        ],
      },
      {
        heading: "Implied odds: plaćen kasnije",
        blocks: [
          "Ponekad je call ispod cijene ipak ispravan, jer kad pogodiš osvajaš više od trenutnog pota. Taj višak su implied odds.",
          "Na turnu je pot 20 bb, a protivnik beta 10 bb: call treba 25 %. Imaš open-ended straight draw, 8 outova, i pogađaš u 8 / 46 slučajeva, oko 17,4 %. Da bi bio na nuli, pot koji osvajaš kad pogodiš mora u prosjeku biti 10 ÷ (8 / 46) = 57,5 bb. Pot nakon tvog calla je 20 + 10 + 10 = 40 bb, pa na riveru, kad pogodiš, moraš osvojiti još 57,5 − 40 = 17,5 bb.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 30, bet: 10, share: 0.174 },
            caption: "Equity tvog drawa je ispod cijene, pa call sam po sebi gubi. Implied odds moraju nadoknaditi razliku novcem osvojenim kasnije.",
          },
          {
            checkpoint: {
              question: "Ista situacija, ali protivniku nakon ovog beta ostaje samo 12 bb. Mogu li implied odds spasiti call?",
              options: ["Da", "Ne"],
              answer: 1,
              explain: "Kad pogodiš, trebaš u prosjeku još 17,5 bb, a on nikad ne može platiti više od 12 bb koliko mu je ostalo. Kratki stackovi iza ubijaju implied odds.",
            },
          },
          "Implied odds trebaju tri stvari: novac iza koji možeš osvojiti, ruku koju protivnik ne vidi da dolazi i protivnika koji plati kad pogodiš.",
        ],
      },
      {
        heading: "Reverse implied odds",
        blocks: [
          "Događa se i suprotno: pogodiš i izgubiš više, jer je tvoja poboljšana ruka i dalje druga najbolja. Obično su krive dominirane ruke.",
          {
            list: [
              "Top par sa slabim kickerom protiv raspona punog boljih kickera.",
              "Nizak flush draw kad je moguća viša boja.",
              "Donji kraj skale koju pobjeđuje viša skala.",
            ],
          },
          "Takve ruke osvajaju male potove i gube velike. Izvan pozicije i s dubokim stackovima šteta raste, što je još jedan razlog zašto big blind folda offsuit ruke koje izgledaju igrivo.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Realizirani equity = sirovi equity × R. S cijenom uspoređuj njega, a ne sirovi equity.",
        "Pozicija, suited karte, povezanost i inicijativa podižu R; igra izvan pozicije i dominacija ga spuštaju.",
        "Implied odds trebaju novac iza, skrivenu ruku i protivnika koji plaća.",
        "Ruke koje slažu drugu najbolju ruku nose reverse implied odds: osvajaju malo, gube puno.",
      ],
      breaks: [
        "Realizacija nije svojstvo same ruke; ista ruka realizira više u poziciji ili s manje novca iza.",
        "Implied odds lako je precijeniti. Protiv kratkih stackova ili opreznih igrača koristi običnu cijenu.",
      ],
    },
    exercises: {
      "bb-vs-btn":
        "Dvanaest odluka iz big blinda protiv opena s buttona na 100 big blindova, 6-max, s naglaskom na tijesne ruke. Fold, call ili 3-bet, a Railov chart to ocjenjuje. Primijeti koje suited i offsuit ruke sa sličnim sirovim equityjem završe na suprotnim stranama.",
    },
    checks: [
      { fn: "product", args: [0.4, 0.8], value: 0.32 },
      { fn: "sum", args: [2.5, 0.5, 1], value: 4 },
      { fn: "requiredEquity", args: [4, 1.5], value: 0.273 },
      { fn: "requiredEquity", args: [30, 10], value: 0.25 },
      { fn: "ratio", args: [8, 46], value: 0.174 },
      { fn: "ratio", args: [460, 8], value: 57.5 },
      { fn: "sum", args: [20, 10, 10], value: 40 },
      { fn: "sum", args: [57.5, -40], value: 17.5 },
    ],
  },
};

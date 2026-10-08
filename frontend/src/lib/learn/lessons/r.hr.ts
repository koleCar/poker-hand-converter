import type { LessonBodies } from "./types";

/**
 * Staza 4 — river, hrvatski (Learn L3): R1 betanje rivera, R2 suočavanje s
 * betovima na riveru, R3 river u 3-bet potovima. Ista struktura kao
 * `r.en.ts`, s istim brojevima (decimalni zarez) i istim `checks`; poker
 * riječi ostaju one kojima se služe hrvatski igrači.
 */
export const rHr: LessonBodies<
  "river-polarisation" | "thin-value" | "choosing-bluffs-blockers" | "river-sizing" | "bluff-catching" | "facing-river-raises" | "3bp-river"
> = {
  "river-polarisation": {
    sections: [
      {
        heading: "Value bet mora dobiti call od slabijeg",
        blocks: [
          "Na riveru više nema karata koje dolaze. Bet može osvojiti više od checka samo na dva načina: slabija ruka calla ili jača ruka folda. Usporedi ga s checkanjem do showdowna. Recimo da betaš 10 bb u 20 bb i dobiješ call. Kad si ispred, osvajaš 10 bb više nego što bi check; kad si iza, gubiš 10 bb više.",
          "Ako si ispred u 60 % slučajeva kad dobiješ call, svaki call donosi 0,6 × 10 − 0,4 × 10 = 6 − 4 = 2 bb više od checka. Na 50 % ne donosi ništa, a ispod 50 % bet gubi. Value bet mora dobivati više od pola puta kad dobije call — protiv ruku koje callaju, a ne protiv cijelog raspona.",
          {
            widget: { id: "value-bet", pot: 20, bet: 10, share: 0.5 },
            caption: "Bet od 10 bb u 20 bb. Pomakni koliko često dobivaš kad dobiješ call preko 50 % i natrag.",
          },
        ],
      },
      {
        heading: "Zašto se rasponi na riveru dijele",
        blocks: [
          "Primijeni to na cijeli raspon i on se dijeli na tri dijela. Jake ruke betaju: slabije ruke ih callaju. Ruke bez showdown vrijednosti betaju dio vremena: checkom s njima nikad ne dobivaš, pa su one blefovi. Sredina — drugi parovi, slabi parovi, as kao najviša karta — checka: bet bi dobio call samo od boljih, a foldao bi samo slabije.",
          "Railova rješenja rivera pokazuju upravo taj oblik. U poziciji nakon checka najjače klase većinom betaju, srednji i slabi parovi checkaju najčešće od svih, as kao najviša karta checka daleko više od ruku bez para, a promašeni drawovi i ruke bez para betaju velik dio vremena.",
          {
            checkpoint: {
              question: "U poziciji na riveru, nakon checka protivnika: koju klasu Railovo rješenje najčešće checka?",
              options: ["Boju", "Drugi par", "Promašeni draw na skalu bez para"],
              answer: 1,
              explain:
                "Boja beta zbog valuea. Promašeni draw može dobiti samo betom, pa dio vremena blefira. Drugi par pobjeđuje blefove koji bi callali i gubi od valuea koji bi callao, pa bet ništa ne dobiva: checka i na showdownu dobiva kad je ispred.",
            },
          },
        ],
      },
      {
        heading: "Koliko blefova",
        blocks: [
          "Polariziranom rasponu trebaju blefovi, inače nitko ne calla njegov value. Koliko? Toliko da ruka koja pobjeđuje samo blefove callom igra na nulu. Za bet veličine pota, 20 u 20, caller riskira 20 da osvoji 40, pa blefovi moraju biti 20 / (20 + 40), oko trećine betova. Za pola pota, 10 u 20, to je 10 / (20 + 20) = 25 %.",
          "Veći betovi nose više blefova, manji manje. To je most prema veličinama, lekcija R1-L4.",
          {
            widget: { id: "bluff-catcher", pot: 20, bet: 20, share: 0.33 },
            caption: "Bet veličine pota na riveru. Mijenjaj udio blefova i vidi gdje call bluff-catchera prelazi iz gubitka u dobitak.",
          },
          {
            note: {
              tone: "approximate",
              text: "Riveri se rješavaju na zahtjev: preflop rasponi iz chartova, suženi na flopu i turnu Railovim heurističkim modelom, riješeni s betovima od 33 %, 75 % i 150 % pota i all-inom. Podjela, bojanje i vježbe čitaju isto rješenje kojim se ocjenjuju riveri u analizi.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Betaj zbog valuea samo kad dobivaš više od pola puta kad dobiješ call.",
        "Betaj jake ruke, checkaj sredinu, blefiraj rukama koje checkom ne mogu dobiti.",
        "As kao najviša karta i slabi parovi checkaju daleko češće od ruku bez ikakvog para.",
        "Veći betovi trebaju više blefova: bet veličine pota otprilike jedan od tri.",
      ],
      breaks: [
        "Protiv igrača koji calla sa svakim parom sredina postaje tanki value, a blefova je manje.",
        "Protiv igrača koji previše folda blefiraj više ruku koje checkom ne mogu dobiti.",
      ],
    },
    exercises: {
      "river-split": "Tri rivera u poziciji nakon checka: svaku klasu ruku stavi u check, mali, veliki bet ili overbet, ocijenjeno klasu po klasu.",
      "paint-the-bets": "Dva rivera u poziciji nakon checka: oboji ruke svog raspona koje Railovo rješenje beta, ocijenjeno ruku po ruku.",
      "river-basics": "Pet odluka na riveru bilo koje vrste, ocijenjeno Railovim rješenjem rivera.",
      "your-hands": "Tvoje prve odluke na riveru, najskuplje prve.",
    },
    checks: [
      { fn: "product", args: [0.6, 10], value: 6 },
      { fn: "product", args: [0.4, 10], value: 4 },
      { fn: "sum", args: [6, -4], value: 2 },
      { fn: "bluffShare", args: [20, 20], value: 0.333 },
      { fn: "bluffShare", args: [20, 10], value: 0.25 },
    ],
  },

  "thin-value": {
    sections: [
      {
        heading: "Što znači tanko",
        blocks: [
          "Tanki value bet je onaj koji dobiva tek malo više od pola puta kad dobije call. Isplati se, jer mala prednost na svakom callu se zbraja, a propustiti ga tihi je leak: check iza s rukom koju bi platili ni u jednoj ruci ne izgleda kao gubitak.",
          "Izračunaj. Betaš 7 bb u 20 bb s top parom. Protivnik calla u 60 % slučajeva, a ti si ispred 60 % callova. Po callu osvajaš 7 bb šest puta od deset i gubiš ih četiri puta: 0,6 − 0,4 = 0,2 beta, 1,4 bb. Uz call u 60 % slučajeva to je 0,6 × 1,4 = 0,84 bb po betu više od checka.",
          {
            widget: { id: "value-bet", pot: 20, bet: 7, share: 0.6 },
            caption: "Bet od 7 bb u 20 bb, s callom u 60 % slučajeva. Pomiči koliko si često ispred callova.",
          },
        ],
      },
      {
        heading: "Betaj malo",
        blocks: [
          "Što je value tanji, to je bet manji. Mali bet dobiva call od više ruku koje pobjeđuješ i košta manje kad naleti na bolju. Railova rješenja se slažu: u poziciji nakon checka top parovi betaju otprilike pola vremena, a mala veličina čini daleko veći dio njihovih betova nego kod najjačih ruku; izvan pozicije, kao prvi na potezu, top parove beta uglavnom malo.",
          {
            checkpoint: {
              question: "Izvan pozicije na riveru, prvi na potezu s top parom: koju veličinu Railovo rješenje najčešće bira kad beta?",
              options: ["Trećinu pota", "Tri četvrtine pota", "Pot i pol"],
              answer: 0,
              explain:
                "Top par je ispred mnogih ruku koje callaju mali bet i malo onih koje callaju velik. Izvan pozicije ne može ni računati na bet iza sebe, pa beta malo da dobije call od slabijih parova, a ostatak checka.",
            },
          },
        ],
      },
      {
        heading: "Kad ga raise učini pretankim",
        blocks: [
          "Svaki raise na koji moraš foldati košta te bet. Ako protivnik iz primjera uz to raisea u 5 % slučajeva, a ti foldaš, svaki raise košta barem tih 7 bb: 0,05 × 7 = 0,35 bb, što ostavlja 0,84 − 0,35 = 0,49 bb. Neka raisea češće ili calla rjeđe, i tanki bet postaje gubitak.",
          "Zato je tanki value tanji protiv pasivnih igrača, a manje tanak protiv igrača koji raiseaju river: ista ruka protiv jednog je bet, a protiv drugog check.",
          {
            note: {
              tone: "approximate",
              text: "Riveri se rješavaju na zahtjev: rasponi iz chartova, suženi na flopu i turnu Railovim heurističkim modelom, s betovima od 33 %, 75 % i 150 % pota i all-inom. Vježbe dijele ruke u kojima Railovo rješenje miješa, a ondje živi tanki value.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Betaj kad god dobivaš više od pola puta kad dobiješ call, makar i malo.",
        "Tanki value beta malo.",
        "Svaki raise na koji moraš foldati košta cijeli bet: uračunaj ga.",
        "Ne checkaj iza jaku ruku koju bi platili.",
      ],
      breaks: [
        "Protiv pasivnog callera betaj tanje i malo veće.",
        "Protiv igrača koji često raisea river checkaj više svojih najtanjih betova.",
      ],
    },
    exercises: {
      "thin-rivers": "Pet rivera u poziciji nakon checka, dijeljene ruke u kojima Railovo rješenje miješa: check ili koja veličina?",
      "thin-first": "Tri rivera izvan pozicije, prvi na potezu, dijeljene ruke u kojima rješenje miješa.",
      "your-hands": "Tvoje prve odluke na riveru i ruke označene zbog checka iza s vrlo jakom rukom, najskuplje prve.",
    },
    checks: [
      { fn: "sum", args: [0.6, -0.4], value: 0.2 },
      { fn: "product", args: [0.2, 7], value: 1.4 },
      { fn: "product", args: [0.6, 1.4], value: 0.84 },
      { fn: "product", args: [0.05, 7], value: 0.35 },
      { fn: "sum", args: [0.84, -0.35], value: 0.49 },
    ],
  },

  "choosing-bluffs-blockers": {
    sections: [
      {
        heading: "Blefiraj onim što checkom ne može dobiti",
        blocks: [
          "Prvo pitanje o blefu je što ruka gubi time što ne checka. As kao najviša karta i mali parovi ponekad dobiju na showdownu; ruka bez ikakvog para nikad. Zato ruke s najmanje showdown vrijednosti postaju prvi blefovi, a ruke s nešto vrijednosti i dalje checkaju.",
          "Railova rješenja rivera kažu isto. U poziciji nakon checka, a još više izvan pozicije, as kao najviša karta checka daleko češće od ruku bez para, koje čine većinu blefova.",
          {
            checkpoint: {
              question: "U poziciji na riveru, nakon checka protivnika: s čime Railovo rješenje češće blefira?",
              options: ["S asom kao najvišom kartom", "S kraljem kao najvišom kartom, bez para i bez drawa"],
              answer: 1,
              explain:
                "As kao najviša karta dobiva neke showdowne protiv promašenih drawova i slabih ruku koje su mu checkale; check čuva te dobitke. Kralj kao najviša karta checkom gotovo nikad ne dobiva, pa ga bet ne košta ništa što je imao.",
            },
          },
        ],
      },
      {
        heading: "Brojanje kombinacija",
        blocks: [
          "Da bi birao među blefovima, moraš brojati ruke, a [[combos-and-card-removal|kombinacije i uklanjanje karata]] su način. Par ima 6 kombinacija, suited ruka 4, offsuit ruka 12. As-kralj, suited i offsuit, ima 4 × 4 = 16.",
          "Svaka karta koju vidiš uklanja kombinacije kojima je potrebna. Drži jednog asa i ostaje samo 3 × 4 = 12 as-kraljeva. Na boardu s kraljem kao najvišom kartom ostala su tri kralja, a bilo koja dva čine set: 3 × 2 / 2 = 3 kombinacije; drži sam kralja i ostaje samo 2 × 1 / 2 = 1.",
          {
            widget: { id: "combos", preset: "sets-k72", hand: ["Kh", "Qd"] },
            caption: "Setovi na K♦7♣2♥ s K♥Q♦ u ruci: gledaj kako kombinacije kraljeva padaju.",
          },
        ],
      },
      {
        heading: "Blokiraj callove, ostavi foldove",
        blocks: [
          "Blef radi kad drugi igrač folda. Zato najbolji blefovi drže karte iz ruku koje bi callale — uklanjajući dio njih — a nijednu iz ruku koje bi foldale. Blef koji drži kartu top para s kojim bi protivnik callao čini taj call manje vjerojatnim; blef koji drži kartu promašenih drawova koji bi foldali čini foldove manje vjerojatnima.",
          "Uklanjanje karata samo je jedan od nekoliko učinaka, a rješenje ih sve važe odjednom: showdown vrijednost, što ruka blokira i što linija govori. Dvije ruke koje izgledaju slično zato mogu igrati različito; vježbe ti dijele upravo takve ruke.",
          {
            note: {
              tone: "approximate",
              text: "Riveri se rješavaju na zahtjev: rasponi iz chartova, suženi na flopu i turnu Railovim heurističkim modelom, s betovima od 33 %, 75 % i 150 % pota i all-inom.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Blefiraj najprije rukama koje checkom ne mogu dobiti.",
        "Broji kombinacije: 6 za par, 4 suited, 12 offsuit; svaka vidljiva karta neke uklanja.",
        "Biraj blefove koji drže karte ruku koje callaju.",
        "Izbjegavaj blefove koji drže karte ruku koje foldaju.",
      ],
      breaks: [
        "Protiv igrača koji nikad ne folda par prestani blefirati, što god držao.",
        "Protiv igrača koji folda sve osim nutsa poslužit će bilo koja ruka bez showdown vrijednosti.",
      ],
    },
    exercises: {
      "count-combos": "Šest brojanja koliko kombinacije neke ruke protivnik još može imati, bez karata koje vidiš.",
      "bluff-rivers": "Pet rivera u poziciji nakon checka, dijeljene ruke u kojima Railovo rješenje miješa: blef ili check?",
      "your-hands": "Tvoje prve odluke na riveru, najskuplje prve.",
    },
    checks: [
      { fn: "product", args: [4, 4], value: 16 },
      { fn: "product", args: [3, 4], value: 12 },
      { fn: "product", args: [3, 2], value: 6 },
      { fn: "ratio", args: [6, 2], value: 3 },
      { fn: "product", args: [2, 1], value: 2 },
      { fn: "ratio", args: [2, 2], value: 1 },
    ],
  },

  "river-sizing": {
    sections: [
      {
        heading: "Veličina prati oblik raspona",
        blocks: [
          "Veličina beta na riveru izbor je raspona s kojim betaš. Polarizirani raspon — najjače ruke i blefovi — želi velik bet: jake ruke dobivaju više, a bluff-catcher koji se suočava s njim mora odlučiti o puno novca. Raspon tanjih value ruku želi mali: dobiva call od slabijih ruku koje pobjeđuje.",
          "Railova rješenja rivera, koja mogu betati trećinu pota, tri četvrtine ili pot i pol ili ići all-in, razvrstavaju klase upravo tako. Najjače ruke najviše koriste velike veličine i overbet; kod top parova i dva para mala veličina čini daleko veći dio betova; blefovi betaju veliko zajedno s nutsom.",
        ],
      },
      {
        heading: "Cijena svake veličine",
        blocks: [
          "Blef od trećine pota, 6,6 bb u 20 bb, treba foldove u oko 24,8 % slučajeva. Overbet od 30 bb u 20 bb treba 30 / 50 = 60 %, a caller mora braniti samo 20 / 50 = 40 % raspona da ga zaustavi.",
          "Overbet dakle radi samo ondje gdje je raspon callera pun ruku koje na njega moraju foldati: kad je capped. U poziciji nakon checka uobičajeno je mjesto, i Railovo rješenje ondje overbeta osjetno češće nego izvan pozicije kao prvi na potezu.",
          {
            widget: { id: "bet-math", focus: "mdf", pot: 20, bet: 30 },
            caption: "Overbet od 30 bb u 20 bb. Probaj trećinu pota, pa pot, i vidi kako se mijenja obrana koja se traži od callera.",
          },
        ],
      },
      {
        heading: "Zašto nuts ponekad beta malo",
        blocks: [
          "Kad bi svaki mali bet bio tanki value, protivnik bi ga mogao raiseati svaki put. Zato Railovo rješenje drži dio najjačih ruku u maloj veličini: mali bet nosi nekoliko ruku koje rado dočekaju raise.",
          {
            checkpoint: {
              question: "Zašto Railovo rješenje rivera neke od najjačih ruku beta malo?",
              options: [
                "Zato što mali betovi s jakim rukama osvajaju više",
                "Da raspon malog beta ne bude samo tanki value koji bi raise kaznio",
                "Zato što ih rješenje ne može betati veliko",
              ],
              answer: 1,
              explain:
                "Većina najjačih ruku ipak beta veliko. Nekoliko njih u maloj veličini štiti je: raise protiv malog beta sada ponekad naleti na nuts, pa ga protivnik ne može slobodno raiseati.",
            },
          },
          {
            note: {
              tone: "approximate",
              text: "Riveri se rješavaju na zahtjev: rasponi iz chartova, suženi na flopu i turnu Railovim heurističkim modelom, s betovima od 33 %, 75 % i 150 % pota i all-inom. Podjela ih grupira kao mali (do pola pota), veliki (do pota) i overbet.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Polarizirani raspon, velik bet; tanki value, mali bet.",
        "Overbetaj kad je drugi raspon capped, a tvoj drži nuts.",
        "Blef od trećine pota treba otprilike četvrtinu foldova; overbet od pota i pol treba 60 %.",
        "Drži nekoliko jakih ruku u maloj veličini.",
      ],
      breaks: [
        "Protiv igrača koji calla svaku veličinu sa svakim parom povećaj value betove i prestani s overbet blefovima.",
        "Protiv igrača koji folda na velike betove, a calla male, blefiraj veliko, a value betaj malo.",
      ],
    },
    exercises: {
      "sizing-split": "Tri rivera u poziciji nakon checka: svaku klasu ruku stavi u check, mali, veliki bet ili overbet, ocijenjeno klasu po klasu.",
      "sizing-rivers": "Pet odluka na riveru, dijeljene ruke u kojima Railovo rješenje miješa veličine.",
      "your-hands": "Tvoje prve odluke na riveru, najskuplje prve.",
    },
    checks: [
      { fn: "alpha", args: [20, 6.6], value: 0.248 },
      { fn: "alpha", args: [20, 30], value: 0.6 },
      { fn: "mdf", args: [20, 30], value: 0.4 },
      { fn: "sum", args: [20, 30], value: 50 },
    ],
  },

  "bluff-catching": {
    sections: [
      {
        heading: "Cijena calla",
        blocks: [
          "Bluff-catcher pobjeđuje svaki blef i gubi od svakog value beta. Hoće li callati, pitanje je o rasponu koji beta, a cijena ti govori koliko blefova on mora sadržavati. Pred betom od 15 bb u 20 bb callaš 15 da osvojiš 35: trebaš dobiti u 15 / (35 + 15) = 30 % slučajeva.",
          "Veći betovi traže više: 30 bb u 20 bb traži 30 / 80, 37,5 %. Manji manje: trećina pota, 6,6 bb u 20 bb, oko 19,9 %.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 35, bet: 15 },
            caption: "Call od 15 bb u pot od 35 bb. Pomakni bet na trećinu pota i na overbet.",
          },
        ],
      },
      {
        heading: "Prebroji value i blefove",
        blocks: [
          "Zatim prebroji liniju. Recimo da ruke koje ovako betaju river čine 10 kombinacija valuea i 5 blefova: trećina su blefovi, više od 30 % koliko traži cijena. Call od 15 u 20 osvaja 35 u trećini slučajeva i gubi 15 u dvije trećine: oko +1,67 bb po callu.",
          "Tvoje karte mijenjaju brojanje. Karta iz protivnikovih value ruku uklanja dio njih i čini call boljim; karta iz promašenih drawova s kojima blefira uklanja blefove i čini ga lošijim. Minimalna obrana, ovdje 20 / 35, oko 57 %, govori koliki dio cijelog tvog raspona mora nastaviti; ne govori koje ruke.",
          {
            widget: { id: "bluff-catcher", pot: 20, bet: 15, share: 0.33 },
            caption: "15 bb u 20 bb. Mijenjaj udio blefova i vidi gdje call počinje dobivati.",
          },
        ],
      },
      {
        heading: "Veći betovi, više foldova",
        blocks: [
          "Railova rješenja rivera foldaju više sredine što je bet veći. Protiv trećine pota većina srednjih parova calla; protiv tri četvrtine većina ih folda; protiv pota i pol još više, a jake ruke nose najveći dio obrane.",
          {
            checkpoint: {
              question: "U poziciji na riveru pred betom: uz koju veličinu Railovo rješenje najčešće folda srednje parove?",
              options: ["Trećinu pota", "Tri četvrtine pota", "Pot i pol"],
              answer: 2,
              explain:
                "Overbet traži 37,5 % equityja protiv raspona koji češće drži nuts. Raspon onoga koji beta je polariziran, pa srednji par pobjeđuje samo blefove, a njih nema dovoljno za tu cijenu.",
            },
          },
          {
            note: {
              tone: "approximate",
              text: "Riveri se rješavaju na zahtjev: rasponi iz chartova, suženi na flopu i turnu Railovim heurističkim modelom, s betovima od 33 %, 75 % i 150 % pota i all-inom. Bojanje traži ruke koje callaju ili raiseaju.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Najprije cijena: call podijeljen s potom nakon njega.",
        "Prebroji value i blefove linije, zatim uračunaj karte koje držiš.",
        "Minimalna obrana govori koliko raspona nastavlja, a ne koje ruke.",
        "Što je bet veći, to više tvoje sredine folda.",
      ],
      breaks: [
        "Protiv igrača koji nikad ne blefira river foldaj svaki bluff-catcher.",
        "Protiv igrača koji blefira svakim promašenim drawom callaj više sredine.",
      ],
    },
    exercises: {
      "price-the-call": "Pet cijena na riveru koje izračunaš prije nego što ih kalkulator pokaže.",
      "paint-the-calls": "Dva rivera pred betom: oboji ruke svog raspona koje Railovo rješenje calla ili raisea, ocijenjeno ruku po ruku.",
      "catch-rivers": "Pet rivera u poziciji pred betom: fold, call ili raise, ocijenjeno Railovim rješenjem rivera.",
      "your-hands": "Tvoje odluke na riveru pred betom, najskuplje prve, i ruke označene zbog callova ili foldova koje je analiza dovela u pitanje.",
    },
    checks: [
      { fn: "requiredEquity", args: [35, 15], value: 0.3 },
      { fn: "requiredEquity", args: [50, 30], value: 0.375 },
      { fn: "requiredEquity", args: [26.6, 6.6], value: 0.199 },
      { fn: "bluffCatcherEv", args: [20, 15, 0.3333], value: 1.67, tolerance: 0.01 },
      { fn: "mdf", args: [20, 15], value: 0.57, tolerance: 0.005 },
    ],
  },

  "facing-river-raises": {
    sections: [
      {
        heading: "Raise je jak",
        blocks: [
          "Kad ti netko raisea bet na riveru, govori ti da se njegov raspon suzio na ruke koje pobjeđuju one s kojima betaš zbog valuea, plus blefove koje odabere. U Railovim rješenjima rivera raspon koji raisea uglavnom su jake gotove ruke, a odgovor na njega je fold: kad mu se bet raisea, rješenje folda otprilike dvije trećine svojih top parova i dva para.",
          "Cijena izgleda primamljivo. Betaš 15 bb u 20 bb i dobiješ raise na 52,5 bb. Pot je 20 + 15 + 52,5 = 87,5 bb, a ti moraš dodati još 52,5 − 15 = 37,5 bb: trebaš 37,5 / 125 = 30 %. Ali call toliko treba protiv raspona koji je uglavnom bolji, a jedan par to rijetko ima.",
        ],
      },
      {
        heading: "Koje ruke nastavljaju",
        blocks: [
          "Nastavljaju ruke koje pobjeđuju dio raspona koji raisea: skale i boje češće nastavljaju nego što foldaju, a sam vrh — full house i jače — dobar dio vremena re-raisea.",
          "Važna je i veličina tvog beta. Mali bet poziva raise: Railovo rješenje raisea male betove na riveru puno češće nego velike, a njegovi raiseovi protiv malih betova sadrže više blefova. Protiv overbeta raise je blizu nutsa.",
          {
            checkpoint: {
              question: "Protiv koje veličine tvog beta na riveru Railovo rješenje najčešće raisea?",
              options: ["Trećine pota", "Tri četvrtine pota", "Pota i pol"],
              answer: 0,
              explain:
                "Mali bet sadrži mnogo tankih value ruku koje ne podnose raise, a raise je jeftin u odnosu na pot. Protiv velikog beta raspon je polariziran i jak, i za raise treba nuts.",
            },
          },
        ],
      },
      {
        heading: "Fold nije slabost",
        blocks: [
          "Sama cijena nikad ne odlučuje o callu protiv raisea: odlučuje raspon. Kad linija kaže da je raise value, foldaj ruke s jednim parom bez žaljenja, a nastavi callati s rukama koje pobjeđuju i njegov value, a ne samo blefove.",
          {
            note: {
              tone: "approximate",
              text: "Riveri se rješavaju na zahtjev: rasponi iz chartova, suženi na flopu i turnu Railovim heurističkim modelom, s betovima od 33 %, 75 % i 150 % pota, raiseovima od tri četvrtine pota i all-inom, najviše dva raisea.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Raise na riveru čitaj kao jak: foldaj većinu ruku s jednim parom.",
        "Nastavi s rukama koje pobjeđuju dio valuea, a ne samo blefove.",
        "Re-raiseaj samo sam vrh.",
        "Mali betovi dobivaju raise češće, i s više blefova, nego veliki.",
      ],
      breaks: [
        "Protiv igrača koji svaki river raisea kao blef callaj do kraja češće.",
        "Protiv igrača koji nikad ne raisea bez nutsa foldaj čak i jake ruke.",
      ],
    },
    exercises: {
      "vs-raise-split": "Tri rivera na kojima ti bet dobiva raise: svaku klasu ruku stavi u fold, call ili raise, ocijenjeno klasu po klasu prema Railovu rješenju rivera.",
      "your-hands": "Tvoje odluke na riveru pred raiseom, najskuplje prve.",
    },
    checks: [
      { fn: "sum", args: [20, 15, 52.5], value: 87.5 },
      { fn: "sum", args: [52.5, -15], value: 37.5 },
      { fn: "requiredEquity", args: [87.5, 37.5], value: 0.3 },
    ],
  },

  "3bp-river": {
    sections: [
      {
        heading: "Stack je jedina veličina",
        blocks: [
          "Prati 3-bet pot iz lekcije T3 do rivera: 85,3 bb u potu i 57,6 bb iza. All-in je oko 0,68 pota. Više nema mjesta za male value betove i velike blefove kao zasebne veličine; većina betanja je shove.",
          "Kao čisti blef shove treba foldove u 57,6 / (85,3 + 57,6), oko 40,3 % slučajeva. Call na njega treba 57,6 / (142,9 + 57,6), oko 28,7 %, a minimalna obrana je 85,3 / 142,9, oko 60 %.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 85.3, bet: 57.6, share: 0.4 },
            caption: "Shove od 57,6 bb u 85,3 bb. Pomiči postotak foldova i vidi gdje blef počinje zarađivati.",
          },
        ],
      },
      {
        heading: "Polarizirani all-inovi",
        blocks: [
          "U Railovim rješenjima 3-bettora u poziciji nakon checka all-in je najčešći bet. Setovi, dva para, skale i boje shoveaju češće nego što rade bilo što drugo; srednji parovi većinom checkaju; a ruke bez para dio vremena shoveaju kao blefovi.",
          {
            checkpoint: {
              question: "U poziciji na riveru 3-bet pota, nakon checka protivnika, s otprilike dvije trećine pota iza: koji bet Railovo rješenje najčešće bira?",
              options: ["Trećinu pota", "Tri četvrtine pota", "All-in"],
              answer: 2,
              explain:
                "Kad je iza tako malo, value ruka gubi novac ako beta manje nego što može, a blef ništa ne dobiva riskirajući manje, jer je odluka callera ista. Shove je i value bet i blef.",
            },
          },
          "Blefove biraj kao u R1: najprije ruke bez showdown vrijednosti, a među njima one koje drže karte ruku koje bi callale.",
        ],
      },
      {
        heading: "Hvatanje blefova protiv capped raspona",
        blocks: [
          "Kao calleru cijena ti je dobra: ispod 30 % protiv shovea. Railova rješenja callaju s većinom top parova i više srednjih parova foldaju nego što callaju. Ostalo odlučuje linija: 3-bettor koji je checkao turn ima manje ruku koje shoveaju zbog valuea, i tvoji bluff-catcheri dobivaju.",
          {
            note: {
              tone: "approximate",
              text: "Riveri se rješavaju na zahtjev: 3-bet rasponi i rasponi callanja iz chartova, suženi na flopu i turnu Railovim heurističkim modelom, s betovima od 33 %, 75 % i 150 % pota i all-inom.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "U 3-bet potu bet na riveru obično je stack: shoveaj jake ruke i blefove, checkaj sredinu.",
        "Shove od otprilike dvije trećine pota kao blef treba oko 40 % foldova, a za call oko 29 % equityja.",
        "Callaj s top parovima; srednje parove foldaj češće nego što ih callaš.",
        "3-bettor koji je checkao turn rjeđe shovea zbog valuea: hvataj više.",
      ],
      breaks: [
        "Dublji 3-bet potovi opet ostavljaju mjesta za manji bet na riveru.",
        "Protiv callera koji nikad ne folda top par shoveaj manje blefova.",
      ],
    },
    exercises: {
      "3bp-river-split": "Dva rivera u 3-bet potu, u poziciji nakon checka: svaku klasu ruku stavi u check, mali, veliki bet ili overbet, ocijenjeno klasu po klasu.",
      "3bp-rivers": "Pet odluka na riveru u 3-bet potovima, u bilo kojoj ulozi, ocijenjeno Railovim rješenjem rivera.",
      "your-hands": "Tvoje odluke na riveru u 3-bet potovima, najskuplje prve.",
    },
    checks: [
      { fn: "ratio", args: [57.6, 85.3], value: 0.68, tolerance: 0.005 },
      { fn: "alpha", args: [85.3, 57.6], value: 0.403 },
      { fn: "sum", args: [85.3, 57.6], value: 142.9 },
      { fn: "requiredEquity", args: [142.9, 57.6], value: 0.287 },
      { fn: "mdf", args: [85.3, 57.6], value: 0.6, tolerance: 0.005 },
    ],
  },
};

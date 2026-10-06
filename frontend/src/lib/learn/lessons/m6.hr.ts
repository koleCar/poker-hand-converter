import type { LessonBodies } from "./types";

/**
 * M6 — 3-bet i 4-bet potovi, hrvatski. Ista struktura kao `m6.en.ts`, s istim
 * brojevima (decimalni zarez) i istim `checks`; poker riječi ostaju one kojima
 * se služe hrvatski igrači, kao u `content/betting.hr.ts`.
 */
export const m6Hr: LessonBodies<"range-splitting-ip-vs-checks-3bp"> = {
  "range-splitting-ip-vs-checks-3bp": {
    sections: [
      {
        heading: "Situacija, s obje strane",
        blocks: [
          "Ova lekcija govori o jednom trenutku koji pomiče puno novca: 3-bet pot, ti si u poziciji, a igrač izvan pozicije ti checka. Do njega možeš doći na dva načina, i oni se igraju različito.",
          {
            list: [
              "Uloga A, 3-bettor u poziciji: cutoff otvara, ti na buttonu napraviš 3-bet, cutoff calla i checka flop.",
              "Uloga B, caller u poziciji: otvaraš na buttonu, big blind napravi 3-bet, ti callaš, a big blind checka.",
            ],
          },
          "U oba slučaja cijeli tvoj raspon sada ima tri mogućnosti: mali bet, veliki bet ili check iza. Podijeliti raspon znači odlučiti koja ruka ide kamo, i zašto, prije nego što pomisliš na jednu ruku koju držiš.",
          {
            note: {
              tone: "conceptual",
              text: "Dio ove lekcije o flopu zasad je konceptualan. Railova knjižnica flopova još nije uključena, pa se podjela na flopu uči riječima, a vježbe se igraju na turnu i riveru, koje Rail već danas rješava.",
            },
          },
        ],
      },
      {
        heading: "Pot i stackovi",
        blocks: [
          "Uloga A na 100 bb, s veličinama iz Railovih tablica: cutoff otvara na 2,5 bb, ti na buttonu napraviš 3-bet na 7,5 bb (tri puta open, u poziciji), blindovi foldaju, a cutoff calla. Pot je 7,5 + 7,5 + 0,5 + 1 = 16,5 bb, a svakom igraču ostaje 100 − 7,5 = 92,5 bb: SPR je 92,5 / 16,5, oko 5,6.",
          "Uloga B: otvaraš na 2,5 bb na buttonu, small blind folda, big blind napravi 3-bet na 10 bb (četiri puta open, izvan pozicije), a ti callaš. Pot je 10 + 10 + 0,5 = 20,5 bb, a iza je 100 − 10 = 90 bb: SPR je oko 4,4.",
          "Uz ovakav SPR jedan dobar par često je ruka s kojom rado igraš za stack, a svaki bet na flopu prvi je korak plana koji može završiti all-inom.",
          {
            widget: { id: "spr", pot: 16.5, stack: 92.5 },
            caption:
              "Flop uloge A na 100 bb. Promijeni broj streetova da vidiš jednak bet s kojim sve uđe, a zatim postavi stack na 192,5 bb da vidiš isti pot na 200 bb.",
          },
        ],
      },
      {
        heading: "Tri skupine, pet poslova",
        blocks: [
          "Svaka skupina obavlja drukčiji posao. Kad znaš posao, možeš smjestiti i ruku koju nikad nisi proučavao.",
          {
            list: [
              "Value: dobiti call od slabijih ruku.",
              "Zaštita: gotova ruka koju se može prestići beta da ne dijeli besplatne karte.",
              "Uskraćivanje equityja: overkarte i backdoor drawovi dobili bi jeftin equity od checka; bet ih tjera da plate ili foldaju.",
              "Fold equity: osvojiti pot odmah s rukom koja na showdownu rijetko dobiva.",
              "Kontrola pota: držati pot malim s rukom koja želi doći do showdowna, a ne podnosi raise.",
            ],
          },
          "Mali bet je uglavnom value, zaštita i uskraćivanje equityja, na boardovima na kojima si ukupno ispred. Veliki bet je polariziran: jake ruke koje žele velik pot i drawovi koji ga mogu osvojiti sada ili kasnije. Check iza je kontrola pota i besplatan equity, uz nekoliko jakih ruku zbog kojih tvoji checkovi nisu laka meta.",
          {
            checkpoint: {
              question:
                "Uloga A, dvobojan board na kojem imaš više najjačih ruku. Držiš nut flush draw s dvije overkarte. Što veliki bet radi za ovu ruku?",
              options: ["Value: slabije ruke callaju", "Fold equity sada, plus dosta equityja kad dobije call", "Kontrolu pota"],
              answer: 1,
              explain:
                "Draw rijetko dobiva ako ruka stane ovdje, pa to nije value, a veliki bet je suprotnost kontroli pota. Veliki bet može odmah uzeti pot, a kad dobije call, draw i dalje ima puno equityja. Ta dva razloga zajedno čine jake drawove prirodnim blefovima u skupini velikih betova.",
            },
          },
        ],
      },
      {
        heading: "Uloga A: 3-bettor kad caller checka",
        blocks: [
          "Prvo pročitaj check. U 3-bet potu caller gotovo uvijek checka 3-bettoru, pa ti check govori vrlo malo: cijeli raspon calla je i dalje tu, zajedno s jakim rukama.",
          "Mali betovi glavna su skupina na boardovima na kojima imaš prednost raspona: s asom, suhi s kraljem ili niski i upareni. Overpairovi, top parovi i mnoge ruke sa samo overkartama i backdoor drawovima betaju zajedno. Mala veličina funkcionira jer je raspon calla sažet: ima malo ruku koje mogu napasti mali bet, a mnogo onih koje moraju platiti ili foldati.",
          "Veliki betovi rastu na dinamičnim boardovima na kojima i dalje imaš dovoljno najjačih ruku, primjerice na dvobojnim visokim flopovima. Jake, ali ranjive ruke, poput overpaira, top para s dobrim kickerom i dva para, betaju veliko da izgrade pot prije nego što dođu loše karte na turnu, a pridružuju im se jaki drawovi.",
          "Check iza najveći je na srednjim povezanim boardovima, gdje callerovi džepni parovi, suited connectori i suited broadway ruke slažu setove, dva para i skale. Ovdje idu srednji parovi, ruke s jednim parom koje mrze check-raise uz tako malo iza i ruke s asom kao najvišom kartom koje mogu dobiti na showdownu, uz nekoliko jakih ruku.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "3bet-vs-call", board: ["Ad", "Kc", "4h"] },
            caption:
              "Ilustrativni rasponi 3-beta i calla, napisani ručno za učenje, na A♦K♣4♥. Prebaci board na T♥9♥8♣ i gledaj kako prednost 3-bettora nestaje: to je board na kojem skupina checka iza raste.",
          },
        ],
      },
      {
        heading: "Uloga B: caller kad 3-bettor checka",
        blocks: [
          "Ovdje check nosi stvarnu informaciju. 3-bettor izvan pozicije često beta na visokim boardovima koji pašu njegovu rasponu, pa check ondje naginje srednjim rukama, iako i dalje može skrivati overpair. Na niskim povezanim boardovima checka češće, pa je raspon s kojim checka širi i ima manje najboljih ruku.",
          "Mali betovi tvoja su najšira skupina na suhim, niskim i uparenim boardovima. Srednji i slabi parovi, overkarte s backdoor drawovima i ruke koje zarađuju kad visoke karte bez pogotka foldaju betaju malo u raspon pun takvih ruku.",
          "Veliki betovi pojavljuju se tamo gdje ti imaš najjače ruke: na niskim i srednjim povezanim boardovima, gdje su tvoji setovi, dva para i skale ruke koje 3-bettor rijetko ima. Value ruke i jaki drawovi betaju veliko, veličinom odabranom da stackovi uđu do rivera.",
          "Check iza paše gotovim rukama srednje jačine koje se boje check-raisea, rukama koje će ionako doći do showdowna i realizirati svoj equity, i nekim jakim rukama, osobito kad će 3-bettor vjerojatno betati turn.",
          {
            checkpoint: {
              question: "Uloga B, flop K♠Q♦4♣, a big blind checka. Koja ruka najbolje paše u skupinu checka iza?",
              options: ["4♥4♠, set", "K♥J♥, top par sa slabim kickerom", "7♥6♥, bez para i gotovo bez drawa"],
              answer: 1,
              explain:
                "Set želi izgraditi pot: value. 7♥6♥ nema što pokazati na showdownu, pa ako beta, beta zbog fold equityja. K♥J♥ je sredina: pobjeđuje velik dio raspona koji checka, ali bet često callaju upravo overpairovi, A-K i K-Q koji ga pobjeđuju, a check-raise uz ovaj SPR ostavio bi ga zaglavljenog. Check drži pot malim i i dalje često dobiva na showdownu. Railov solver ponekad će takvu ruku ipak betati; bitan je razlog zbog kojeg bi svaka ruka betala.",
            },
          },
        ],
      },
      {
        heading: "Kako board pomiče podjelu",
        blocks: [
          {
            list: [
              "Visoki, suhi boardovi: kao 3-bettor betaj malo s većinom raspona; kao caller češće checkaj iza, a betove drži malima.",
              "Srednji povezani i dvobojni boardovi: kao 3-bettor polariziraj, s više velikih betova, više checkova i manje malih betova; kao caller betaj češće i veće.",
              "Niski upareni boardovi: mali betovi za onoga tko beta. Jakih ruku je malo, a većina ruku je ili daleko ispred ili ima malo outova.",
              "Jednobojni boardovi: manji betovi i više checkova. Visoke karte boje flusha odlučuju koje ruke betaju.",
            ],
          },
          {
            widget: { id: "board-texture", focus: "dynamism", board: ["Th", "9h", "8c"] },
            caption:
              "T♥9♥8♣: povezan, dvobojan i dinamičan. Ubaci 3♠3♦8♣ ili A♦K♣4♥ i gledaj kako volatilnost pada. Podjela prati istu liniju, od polarizirane prema maloj i čestoj.",
          },
        ],
      },
      {
        heading: "Kako dubina stackova pomiče podjelu: 100 bb protiv 200 bb",
        blocks: [
          "Na 100 bb SPR uloge A od oko 5,6 ostavlja prostora za plan. Tri jednaka beta od oko 65 % pota uvedu stackove do rivera. Čak i bet na flopu od 5,5 bb, trećina pota, ostavlja pot od 16,5 + 5,5 + 5,5 = 27,5 bb uz 87 bb iza, a dva beta od oko 85 % pota dovršavaju posao. Jedan par može betati malo i svejedno igrati za stack.",
          "Kreni s 200 bb i isti mali bet na flopu ostavlja 192,5 − 5,5 = 187 bb iza tog pota od 27,5 bb. Da sve uđe kroz još dva streeta, svaki bet morao bi biti oko 141 % pota. To mijenja podjelu:",
          {
            list: [
              "Ruke s jednim parom sele se iz betanja za value prema checku ili malom betu za tanki value.",
              "Veličine rastu, a checkovi postaju češći, jer veliki betovi trebaju ruke koje žele velik pot.",
              "Ruke koje mogu složiti nuts, poput malih parova, suited connectora i suited asova za wheel, dobivaju na vrijednosti, a overpairovi više nisu blizu nutsa.",
            ],
          },
          {
            checkpoint: {
              question: "Opet uloga A, ali oba su igrača krenula s 200 bb. Pot je i dalje 16,5 bb. Koliki je SPR na flopu?",
              options: ["Oko 5,6", "Oko 11,7", "Oko 23"],
              answer: 1,
              explain:
                "Svakom igraču ostaje 200 − 7,5 = 192,5 bb, a 192,5 / 16,5 je oko 11,7, otprilike dvostruko od brojke na 100 bb. Uloga B na 200 bb slično: 190 / 20,5, oko 9,3. Vezanost za pot dolazi puno kasnije, pa jedan par mora biti oprezniji.",
              math: { fn: "spr", args: [192.5, 16.5], value: 11.7 },
            },
          },
        ],
      },
      {
        heading: "Stvarni protivnici i vježba u Railu",
        blocks: [
          "Mnogi live 3-bettori checkaju samo slabe ruke, a sve jako betaju. Protiv njih je check jak znak da je raspon capped, pa u ulozi B možeš betati češće i s više ruku.",
          "Protiv igrača koji gotovo nikad ne rade check-raise nestaje glavni razlog za check iza sa srednjim rukama: betaj ih za tanki value i zaštitu, i tvoja se skupina checka iza smanjuje. Protiv igrača koji često rade check-raise checkaj iza više takvih ruku.",
          "Vježbe te stavljaju upravo u ovu situaciju na turnu i riveru: 3-bet pot, ti u poziciji, protivnik je checkao. Na turnu biraš između checka, beta od 75 % pota i, kad stack nije veći od tri pota, all-ina. Na riveru biraš između checka, nekoliko veličina beta i all-ina. Ocjena je ona koju analiza daje pravoj ruci.",
          {
            note: {
              tone: "approximate",
              text: "Rasponi koji u ovim vježbama stignu do turna i rivera počivaju na Railovu modelu sužavanja, heurističkoj procjeni toga kako svaki igrač nastavlja na ranijim streetovima, kako i analiza navodi. Tijesnu ocjenu shvati kao tijesnu.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Prvo imenuj posao skupine: value, zaštita, uskraćivanje equityja, fold equity ili kontrola pota.",
        "Kao 3-bettor u poziciji betaj malo i često na visokim, suhim i niskim uparenim boardovima; na srednjim povezanima polariziraj.",
        "Kao caller u poziciji pročitaj check: na visokim boardovima naginje srednjim rukama, na niskim povezanima širok je i capped.",
        "Veliki betovi trebaju najjače ruke; ruke s jednim parom koje ne podnose raise checkaj iza.",
        "Dublji stackovi znače veće veličine, više checkova i manje ljubavi prema jednom paru.",
      ],
      breaks: [
        "Protiv 3-bettora koji checkaju samo slabe ruke betaj daleko češće nego što bi to radila uravnotežena podjela.",
        "Protiv igrača koji rijetko rade check-raise betaj više srednjih ruku za tanki value umjesto da ih checkaš iza.",
        "U multiway potu ili s nejednakim stackovima mijenjaju se SPR i rasponi, a s njima i podjela.",
      ],
    },
    exercises: {
      "flop-split":
        "Stiže s knjižnicom flopova: nakon checka razvrstaj kategorije ruku na mali bet, veliki bet i check iza, pa usporedi svoju podjelu s Railovim rješenjem za taj flop.",
      "turn-3bettor":
        "Dvije situacije na turnu kao 3-bettor u poziciji nakon checka, koje Rail rješava na zahtjev: check, bet od 75 % pota ili all-in kad je stack dovoljno kratak.",
      "turn-caller":
        "Dvije situacije na turnu kao caller u poziciji nakon što 3-bettor checka, s istim izborom. Pročitaj check prije nego što odlučiš.",
      "river-3bettor":
        "Tri situacije na riveru kao 3-bettor u poziciji protiv checka: check ili odaberi veličinu, a ocjenjuje se kao što analiza ocjenjuje pravu ruku.",
      "river-caller":
        "Tri situacije na riveru kao caller u poziciji protiv checka 3-bettora, ocijenjene na isti način.",
      "your-hands":
        "Tvoji vlastiti 3-bet potovi u poziciji u kojima ti je protivnik checkao, na bilo kojem streetu, od najskupljeg naniže. Odaberi skupinu prije nego što vidiš što si napravio.",
    },
    checks: [
      { fn: "product", args: [2.5, 3], value: 7.5 },
      { fn: "sum", args: [7.5, 7.5, 0.5, 1], value: 16.5 },
      { fn: "sum", args: [100, -7.5], value: 92.5 },
      { fn: "spr", args: [92.5, 16.5], value: 5.6 },
      { fn: "product", args: [2.5, 4], value: 10 },
      { fn: "sum", args: [10, 10, 0.5], value: 20.5 },
      { fn: "sum", args: [100, -10], value: 90 },
      { fn: "spr", args: [90, 20.5], value: 4.4 },
      { fn: "geometricBet", args: [16.5, 92.5, 3], value: 0.65 },
      { fn: "ratio", args: [5.5, 16.5], value: 0.333 },
      { fn: "sum", args: [16.5, 5.5, 5.5], value: 27.5 },
      { fn: "sum", args: [92.5, -5.5], value: 87 },
      { fn: "geometricBet", args: [27.5, 87, 2], value: 0.85 },
      { fn: "sum", args: [200, -7.5], value: 192.5 },
      { fn: "sum", args: [192.5, -5.5], value: 187 },
      { fn: "geometricBet", args: [27.5, 187, 2], value: 1.41 },
      { fn: "sum", args: [200, -10], value: 190 },
      { fn: "spr", args: [190, 20.5], value: 9.3 },
    ],
  },
};

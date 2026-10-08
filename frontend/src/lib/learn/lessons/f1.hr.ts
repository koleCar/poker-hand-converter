import type { LessonBodies } from "./types";

/**
 * F1 — single-raised potovi, preflop raiser u poziciji, hrvatski (Learn L2).
 * Ista struktura kao `f1.en.ts`, s istim brojevima (decimalni zarez) i istim
 * `checks`; poker riječi ostaju one kojima se služe hrvatski igrači.
 */
export const f1Hr: LessonBodies<"cbet-why-and-when" | "cbet-by-texture" | "hand-classes-on-the-flop" | "checking-back-and-delayed-cbets"> = {
  "cbet-why-and-when": {
    sections: [
      {
        heading: "Bet zarađuje dvaput",
        blocks: [
          "Button otvara na 2,5 bb, big blind calla i dolazi flop. Pot je 2,5 + 2,5 + 0,5 = 5,5 bb, a iza je 97,5 bb. Big blind checka. Što god držao, bet sada može dobiti na dva načina: big blind folda i odmah uzimaš 5,5 bb, ili calla, a tvoja ruka i dalje osvaja dio većeg pota.",
          "Odredi cijenu prvog načina. Bet od trećine pota, oko 1,8 bb, riskira 1,8 da osvoji 5,5. Kao čisti blef koji nikad ne dobiva kad dobije call, izlazi na nulu kad je udio foldova 1,8 / (5,5 + 1,8), oko 24,7 %. To je [[bluffing-math-alpha-mdf|alfa]], i niska je: mali betovi ne trebaju mnogo foldova.",
          "Sad dodaj drugi način. Recimo da big blind folda u 40 % slučajeva, a kad calla, ti dobivaš u 35 % slučajeva bez daljnjeg betanja. Foldovi donose 0,4 × 5,5 = 2,2 bb. Callovi ostavljaju pot od 5,5 + 1,8 + 1,8 = 9,1 bb, od kojeg osvajaš 35 %, oko 3,19 bb, minus 1,8 koje si uložio: 1,39 bb, zarađeno u 60 % slučajeva, oko 0,83 bb. Zajedno bet vrijedi oko 3,03 bb prije nego što itko ponovno odigra.",
          {
            checkpoint: {
              question: "Čisti blef od trećine pota, 1,8 bb u 5,5 bb. Big blind folda u točno 25 % slučajeva. Otprilike koliko blef zarađuje?",
              options: ["Otprilike nula", "Oko +1,4 bb", "Oko −1,4 bb"],
              answer: 0,
              explain:
                "Foldovi donose 0,25 × 5,5 = 1,375 bb; callovi gube 0,75 × 1,8 = 1,35 bb. Razlika je oko 0,03 bb: 25 % je upravo alfa za ovu veličinu, pa ruka bez equityja izlazi na nulu. Svaki djelić equityja koji ima kad dobije call čista je dobit povrh toga.",
              math: { fn: "bluffEv", args: [5.5, 1.8, 0.25], value: 0.025, tolerance: 0.001 },
              reveal: { id: "bet-math", focus: "alpha", pot: 5.5, bet: 1.8, share: 0.25 },
            },
          },
        ],
      },
      {
        heading: "Zašto raiser beta tako često",
        blocks: [
          "Raspon raisera jači je na većini flopova: drži velike parove i najbolje broadway ruke, koje bi big blind 3-betao ili foldao. To je [[range-advantage|prednost raspona]], i zato raiser može betati mnoge ruke koje same nisu jake. Posuđuju snagu raspona: big blind ne može callati sa svime, pa one dovoljno često osvoje pot.",
          "Ali nemoj iz samog equityja čitati koliko često betati. Dva raspona mogu biti blizu po equityju, a ipak se igrati vrlo različito kad bet dobije call, jer callaju bolje ruke iz raspona branitelja. Pitanje je jesu li tvoje ruke koje betaju i dalje u dobrom stanju protiv ruku koje callaju, a ne je li cijeli raspon ispred prije nego što itko odigra.",
          "Treći razlog je ono što check poklanja. Iza tvog checka big blind vidi besplatan turn sa svakom overkartom, gutshotom i backdoor drawom koji drži. Mali bet te ruke naplaćuje ili ih tjera na fold: to je uskraćivanje equityja, i dio je onoga što bet zarađuje čak i kad to nitko ne kaže.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Kd", "7c", "2h"] },
            caption:
              "Ilustrativni rasponi napisani za učenje, a ne Railovi chartovi: open s buttona protiv calla iz big blinda na K♦7♣2♥. Promijeni board na 8♥7♥6♣ i gledaj kako prednost raisera opada.",
          },
        ],
      },
      {
        heading: "Malo i često, ili veliko i probrano",
        blocks: [
          "Koliko velik bet treba biti ovisi o tome što tvoj raspon drži pri vrhu. Gdje oba igrača imaju otprilike jednako najboljih ruku, a većina prednosti raisera je u sredini, mali bet s mnogo ruku dobro radi: svaka ruka malo zarađuje od foldova i od uskraćivanja equityja. Gdje raiser jasno ima više najboljih ruku, može betati veće, a veći bet tada mora biti polariziran: jake ruke, plus ruke koje se mogu popraviti i pobijediti ono što calla.",
          "Railova knjižnica rješava svaki flop s dvije veličine, trećinom i tri četvrtine pota. Kad rješenje s nekom rukom koristi obje, njihovi EV-ovi su blizu i Rail obje ocjenjuje kao dobar izbor; pravi novac košta plan koji ne odgovara boardu.",
          {
            checkpoint: {
              question: "Na suhom raznobojnom flopu s kraljem, koji plan najbolje odgovara rasponu raisera?",
              options: ["Mali bet sa širokim rasponom", "Veliki bet samo s najjačim rukama", "Check gotovo svega"],
              answer: 0,
              explain:
                "Raiser ima više jakih kraljeva i velikih parova, ali big blind i dalje ima nešto dva para i setova, pa je prednost raspoređena na mnoge ruke, a ne skupljena na samom vrhu. Mali bet dopušta većini raspona da beta: value ruke dobivaju call od slabijih parova, a ostale osvajaju pot ili uskraćuju jeftin equity.",
            },
          },
        ],
      },
      {
        heading: "Check je dio plana",
        blocks: [
          "Check iza nije predaja. Ruke srednje jačine koje pobjeđuju blefove big blinda, ali foldaju na raise, često prolaze bolje s checkom: drže pot malim i svejedno dobivaju na showdownu. Checkaju i neke jake ruke, da bet big blinda na turnu ne naleti na raspon samo slabih ruku.",
          "Izvan pozicije računica je ista, ali je teže realizirati equity i check je privlačniji. Taj slučaj ima svoju lekciju u F2.",
          {
            note: {
              tone: "approximate",
              text: "Vježbe ispod dijele se iz Railove knjižnice flopova, kombinacija po kombinaciju. Tvoje ruke na flopovima koje knjižnica nije riješila čitaju se s najbližeg riješenog flopa po kategoriji ruke, a analiza takve ocjene označava kao mapirane.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Bet zarađuje od foldova i od equityja kad dobije call; zbroji oboje prije odluke.",
        "Blef od trećine pota treba oko četvrtinu foldova; provjeri to [[bluffing-math-alpha-mdf|alfom]], bet ÷ (pot + bet).",
        "Pitaj kako tvoje ruke koje betaju prolaze protiv ruku koje callaju, a ne samo kako se uspoređuju cijeli rasponi.",
        "Betaj malo i često gdje je prednost raspoređena po rasponu; betaj veće i polarizirano gdje imaš više najboljih ruku.",
      ],
      breaks: [
        "Protiv big blinda koji calla svaki flop s bilo kojim parom ili drawom betaj manje čistih blefova, a više tankog valuea.",
        "Protiv onoga koji previše folda na prvi bet betaj još češće, bez obzira na ruku.",
      ],
    },
    exercises: {
      "flop-cbets":
        "Šest flopova iz Railove knjižnice: otvorio si, big blind je callao i checkao. Check, bet od trećine ili od tri četvrtine pota, ocijenjeno rješenjem knjižnice za taj flop.",
      "your-hands": "Tvoji single-raised potovi u kojima si bio preflop raiser i dobio check na flopu, najskuplji prvi.",
    },
    checks: [
      { fn: "sum", args: [2.5, 2.5, 0.5], value: 5.5 },
      { fn: "sum", args: [100, -2.5], value: 97.5 },
      { fn: "alpha", args: [5.5, 1.8], value: 0.247 },
      { fn: "product", args: [0.4, 5.5], value: 2.2 },
      { fn: "sum", args: [5.5, 1.8, 1.8], value: 9.1 },
      { fn: "product", args: [0.35, 9.1], value: 3.19, tolerance: 0.005 },
      { fn: "sum", args: [3.185, -1.8], value: 1.39, tolerance: 0.005 },
      { fn: "product", args: [0.6, 1.385], value: 0.83, tolerance: 0.005 },
      { fn: "sum", args: [2.2, 0.831], value: 3.03, tolerance: 0.005 },
      { fn: "product", args: [0.25, 5.5], value: 1.375 },
      { fn: "product", args: [0.75, 1.8], value: 1.35 },
    ],
  },

  "cbet-by-texture": {
    sections: [
      {
        heading: "Dvije prednosti, dva pitanja",
        blocks: [
          "Svaki flop postavlja raiseru dva pitanja. Koliko često mogu betati? To prati [[range-advantage|prednost raspona]]: čiji je raspon ispred, i za koliko, na ovom boardu. Koliko veliko mogu betati? To prati [[nut-advantage|prednost u nutsu]]: tko ima više ruku na samom vrhu, setova, dva para i skala koje osvajaju velike potove.",
          "To dvoje može pokazivati na različite strane. Na suhom boardu s kraljem raiser je ukupno ispred, ali ima tek malo više najjačih ruku: betaj često i malo. Na srednjem povezanom boardu suited connectori i mali parovi big blinda slažu mnoge jake ruke, a ukupna prednost raisera je tanka: betaj rjeđe, a kad betaš, veći dio toga je veliko.",
          {
            widget: { id: "range-vs-range", focus: "nuts", preset: "btn-vs-bb", board: ["Ts", "9s", "6d"] },
            caption:
              "Ilustrativni rasponi napisani za učenje: tko ima najjače ruke na T♠9♠6♦. Prebaci na A♦K♣4♥ da vidiš kako vrh raspona prelazi raiseru.",
          },
        ],
      },
      {
        heading: "Board po board, iz Railove knjižnice",
        blocks: [
          "Tablica ispod je Railova vlastita knjižnica flopova: za tri česte linije, koliki dio raspona raisera beta na njegovoj prvoj odluci na flopu, u prosjeku preko riješenih flopova u svakoj skupini boardova. Čitaj je kao smjerove, a ne kao brojke za pamćenje.",
          {
            widget: { id: "flop-bets", preset: "btn-bb" },
            caption:
              "Railova rješenja rasponâ iz chartova za 6-max i 100bb. Prebaci liniju na UTG protiv big blinda, ili na 3-bet pot big blinda, i usporedi koje skupine betaju najviše, a koje veliko.",
          },
          {
            list: [
              "Visoki i suhi boardovi, s kraljem ili damom: raiser beta najčešće, uglavnom malo.",
              "Upareni boardovi: često i gotovo uvijek malo; jakih ruku je malo, pa nema s čime graditi velik pot.",
              "Niski boardovi, sa sedmicom i niže, i srednji povezani: big blind ih pogađa, pa raiser češće checka; ono što beta češće je veliko.",
              "Jednobojni boardovi: mali betovi i više checkova; veliki betovi su rijetki, jer jedna karta boje pretvara jaku ruku u drugu najbolju.",
              "Boardovi s asom su poseban slučaj: raiser ima više asova, ali niski boardovi s asom i kartama za wheel daju big blindu skale i dva para.",
            ],
          },
        ],
      },
      {
        heading: "Zaštita i sljedeća karta",
        blocks: [
          "Na statičnom boardu, gdje malo karata na turnu mijenja tko je ispred, srednja ruka malo gubi checkom: nema mnogo toga za zaštititi. Na dinamičnom boardu, gdje mnogi turnovi zatvaraju skale i boje, ista ruka radije beta, i za value sada i da naplati drawove. To je zaštitni dio beta, i raste s time koliko je board dinamičan.",
          {
            widget: { id: "board-texture", focus: "dynamism", board: ["9h", "8h", "6c"] },
            caption: "9♥8♥6♣ protiv K♠7♦2♣: usporedi koliko karata na turnu mijenja najbolju ruku.",
          },
          {
            checkpoint: {
              question: "Raiser drži overpair na 9♥8♥6♣. Zašto ovdje naginje većem betu nego na K♠7♦2♣?",
              options: [
                "Zato što big blind ovdje nikad nema jaku ruku",
                "Zato što mu mnoge karte na turnu štete, pa želi novac u potu sada, a drawove da plate",
                "Zato što veliki bet uvijek donosi više foldova",
              ],
              answer: 1,
              explain:
                "Na 9♥8♥6♣ herčevi, sedmice, desetke i petice mijenjaju board. Overpair je sada ispred, ali ranjiv, pa gradi pot dok je ispred i tjera brojne drawove da plate pravu cijenu. Na K♠7♦2♣ gotovo nijedna karta na turnu mu ne šteti, pa može betati malo ili checkati bez velikog gubitka.",
            },
          },
        ],
      },
      {
        heading: "Vježba",
        blocks: [
          "Vježba podjele daje ti cijeli raspon raisera na jednom od flopova iz knjižnice nakon checka big blinda, razvrstan po klasama ruku. Za svaku klasu odlučuješ checka li uglavnom, beta li malo ili veliko, a Rail svaku klasu ocjenjuje prema svom rješenju tog flopa.",
          {
            note: {
              tone: "approximate",
              text: "Zadaci o prednosti raspona i prednosti u nutsu koriste ručno napisane raspone za učenje iz knjižnice koncepata, a ne Railove chartove, i to kažu. Podjela i tablica dolaze iz Railove knjižnice flopova; tvoje ruke na flopovima koje nije riješila čitaju se s najbližeg riješenog flopa.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "[[range-advantage|Prednost raspona]] određuje koliko često betaš; [[nut-advantage|prednost u nutsu]] koliko veliko.",
        "Visoki suhi i upareni boardovi: betaj često, betaj malo.",
        "Niski i srednji povezani boardovi: češće checkaj; kad betaš, betaj veće.",
        "Jednobojni boardovi: mali betovi i dosta checkova.",
        "Što je board dinamičniji, to tvoje srednje jake ruke više žele betati sada.",
      ],
      breaks: [
        "Big blind koji nikad ne radi check-raise dopušta ti da betaš tanje i češće na boardovima na kojima bi inače checkao.",
        "Dublji stackovi idu u prilog većem broju checkova i većim betovima: jake ruke dobivaju na vrijednosti, a jedan par gubi.",
      ],
    },
    exercises: {
      "split-three-flops":
        "Tri flopa iz Railove knjižnice, ti u poziciji kao raiser nakon checka: svaku klasu ruku stavi u check, mali bet ili veliki bet, a ocjenjuje se klasa po klasa prema rješenju.",
      "who-is-ahead": "Šest boardova: čiji je ilustrativni raspon ukupno ispred, ili je tijesno? Čita Railov kalkulator equityja.",
      "who-has-the-nuts": "Šest boardova: tko na ilustrativnim rasponima ima više najjačih ruku?",
      "your-hands": "Tvoje odluke o c-betu u poziciji u single-raised potovima, najskuplje prve.",
    },
    checks: [],
  },

  "hand-classes-on-the-flop": {
    sections: [
      {
        heading: "Razvrstaj raspon prije ruke",
        blocks: [
          "Kad ti big blind checka, svaka ruka u tvom rasponu spada u jednu od nekoliko klasa, a svaka klasa ima svoj posao. Kad prvo odrediš posao, akcija je puno češće očita nego kad razmišljaš o jednoj ruci koju držiš.",
          {
            list: [
              "Jake gotove ruke, top par s dobrim kickerom i bolje: value; žele call od slabijih.",
              "Srednje gotove ruke, slabi top parovi, srednji parovi i džepni parovi ispod najviše karte: često dobivaju na showdownu, a malo dobivaju od beta koji callaju samo bolje ruke.",
              "Drawovi, od backdoora do otvorenih dro na skalu i drawova na boju: mogu osvojiti pot sada ili se popraviti kad dobiju call.",
              "Zrak, bez para i bez pravog drawa: dobiva samo kad drugi igrač folda.",
            ],
          },
        ],
      },
      {
        heading: "Tko beta, tko checka",
        blocks: [
          "U Railovim rješenjima buttona protiv big blinda najjasniji obrazac je na krajevima. Najjače ruke betaju gotovo uvijek, a setovi i najbolji top parovi često betaju veliko. I zrak beta iznenađujuće često, uglavnom malo, jer nema što dobiti na showdownu, a big blind folda dovoljno.",
          "Klasa koja najviše checka je sredina: drugi parovi, džepni parovi ispod najviše karte i slabi top parovi. Ispred su blefova big blinda, a iza njegovih callova, pa bet malo donosi, a check-raise bi ih ostavio zaglavljene.",
          "Drawovi uglavnom betaju: imaju dva načina da dobiju. Oni koji checkaju često su najslabiji drawovi s nešto vrijednosti na showdownu, poput asa s backdoorom.",
          {
            checkpoint: {
              question: "Button protiv big blinda, flop K♣8♦3♠, checkano ti je. Koja je ruka najprirodniji check?",
              options: ["A♠K♦", "8♥8♣ (set)", "9♣9♥", "Q♥J♥"],
              answer: 2,
              explain:
                "A♠K♦ i set žele value. Q♥J♥ nema par i ima backdoor draw na boju: puno dobiva od foldova. Devetke pobjeđuju blefove big blinda, ali gube od svakog kralja ili osmice koji calla, pa ih bet pretvara u bluff-catcher koji se suočava s raiseom. Check ih jeftino drži u ruci. Railovo rješenje ponekad će takvu ruku ipak betati; bitna je klasa.",
            },
          },
        ],
      },
      {
        heading: "Kada slowplayati",
        blocks: [
          "Slowplay vrlo jake ruke na flopu zvuči pametno, ali u poziciji rijetko je izbor solvera: u Railovim rješenjima buttona protiv big blinda setovi i dva para gotovo nikad ne checkaju flop. Bet već dobiva call od mnogih parova i drawova s kojima big blind nastavlja, i gradi pot za još dva streeta.",
          "Dva razloga za check jake ruke: board je toliko suh da bet tjera na fold sve slabije, ili tvoj raspon checka treba nešto zaštite od napada na turnu. Nijedan ne kaže checkaj svaki set.",
        ],
      },
      {
        heading: "Vježba",
        blocks: [
          "Prvo imenuj klasu, onda odluči. Vježba podjele pokazuje ti vlastitu mješavinu rješenja za svaku klasu na jednom od flopova iz knjižnice, pa vidiš kamo klase stvarno idu.",
          {
            note: {
              tone: "approximate",
              text: "Podjela i vježbe na flopu dolaze iz Railove knjižnice flopova. Tvoje ruke na drugim flopovima čitaju se s najbližeg riješenog flopa po kategoriji ruke, a analiza takve ocjene označava kao mapirane.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Jake ruke betaju; najbolje često betaju veliko na dinamičnim boardovima.",
        "Zrak beta više nego što misliš: nema drugog načina da dobije.",
        "Srednje ruke najviše checkaju: pobjeđuju blefove, a gube od callova.",
        "Drawovi betaju: fold equity sada, equity kad dobiju call.",
      ],
      breaks: [
        "Protiv igrača koji calla sa svime srednje ruke postaju tanki value betovi, a zrak treba češće checkati.",
        "Protiv igrača koji često radi check-raise checkaj više srednjih ruku, a najjače ruke betaj da dobiješ raise.",
      ],
    },
    exercises: {
      "name-the-hand": "Osam ruku na flopu: imenuj klasu svake, a čita je Railov čitač ruku.",
      "split-one-flop": "Dva flopa iz Railove knjižnice: razvrstaj klase ruku raisera na check, mali bet i veliki bet, a ocjenjuje se klasa po klasa.",
      "your-hands": "Tvoje odluke na flopu kao preflop raiser kad si bio na redu za bet ili check, najskuplje prve.",
    },
    checks: [],
  },

  "checking-back-and-delayed-cbets": {
    sections: [
      {
        heading: "Raspon checka",
        blocks: [
          "Kad raiser u poziciji checka iza na flopu, to nije predaja; to je druga polovica plana. Raspon checka drži srednje ruke koje žele showdown, slabe ruke s nešto equityja koje bi radije vidjele besplatnu kartu i nekoliko jakih ruku, da bet big blinda na turnu ne naiđe na tebe bez ičega.",
          "Check iza ima dvije cijene: daješ besplatnu kartu i puštaš big blinda da vidi turn bez plaćanja. Na statičnim boardovima te su cijene male; na dinamičnima veće, i zato se ondje raspon checka smanjuje.",
          {
            checkpoint: {
              question: "Button protiv big blinda na Q♠7♦2♣, checkano ti je. Koja ruka najviše dobiva checkom iza?",
              options: ["Q♥J♥", "7♠6♠", "A♣Q♦"],
              answer: 1,
              explain:
                "A♣Q♦ je jasan value, a Q♥J♥ rado beta za value i zaštitu. 7♠6♠ je srednji par: pobjeđuje blefove big blinda, ali bet calla malo slabijih ruku, a check-raise bi ga natjerao na fold. Check drži pot malim i pušta ga da dobije na showdownu.",
            },
          },
        ],
      },
      {
        heading: "Bet na turnu nakon checka",
        blocks: [
          "Kad checkaš iza, a big blind ponovno checka na turnu, njegov je raspon capped: jake ruke koje drži često bi betale. Tvoj checkani raspon i dalje ima nešto jakih i mnogo srednjih ruku, pa bet na turnu dobro prolazi: tanki value sa srednjim rukama koje su se popravile ili su i dalje ispred, i blefovi s rukama koje su promašile.",
          "To je odgođeni c-bet. Karta na turnu je važna: karta koja pomaže rasponu raisera, poput overkarte na boardu, dobra je za bet; karta koja big blindu zatvara drawove traži više opreza.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 5.5, bet: 4.1, share: 0.45 },
            caption: "Bet na turnu od tri četvrtine pota u 5,5 bb kao čisti blef treba oko 43 % foldova. Pomiči udio foldova da vidiš gdje počinje zarađivati.",
          },
        ],
      },
      {
        heading: "Brzo ili sporo s jakim rukama",
        blocks: [
          "Jaka ruka koja checka iza na flopu odriče se jednog streeta valuea. To se vraća kad big blind beta turn u raspon koji izgleda capped, ili kad tvoj raspon treba zaštitu. Protiv igrača koji rijetko betaju kad im se checka to se nikad ne vraća: betaj svoje jake ruke na flopu.",
          {
            note: {
              tone: "approximate",
              text: "Vježbe na flopu dolaze iz Railove knjižnice flopova; vježbe na turnu rješavaju se na zahtjev iz raspona koje Rail sužava kroz flop. Tvoje ruke na flopovima koje knjižnica nije riješila čitaju se s najbližeg riješenog flopa.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Checkaj iza ruke koje dobivaju na showdownu, ali ne podnose raise.",
        "Drži nekoliko jakih ruku u rasponu checka.",
        "Nakon što flop prođe s checkovima, betaj turn često kad big blind ponovno checka: njegov je raspon capped.",
        "Protiv protivnika koji nikad ne betaju kad im se checka, betaj jake ruke na flopu.",
      ],
      breaks: [
        "Na vrlo dinamičnim boardovima check iza poklanja previše; betaj više srednjih ruku zbog zaštite.",
        "Protiv protivnika koji betaju svaki turn nakon checka checkaj iza više jakih ruku i pusti ih da betaju.",
      ],
    },
    exercises: {
      "check-back-flops":
        "Četiri flopa iz Railove knjižnice, ti u poziciji kao raiser nakon checka, s rukama koje rješenje miješa: bet ili check?",
      "delayed-turns": "Tri turna nakon što si checkao iza na flopu, a big blind ponovno checkao, riješena na zahtjev.",
      "your-hands": "Tvoje ruke označene zbog checka iza s vrlo jakom rukom, najskuplje prve.",
    },
    checks: [{ fn: "alpha", args: [5.5, 4.1], value: 0.427 }],
  },
};

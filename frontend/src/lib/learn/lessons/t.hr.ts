import type { LessonBodies } from "./types";

/**
 * Staza 3 — turn, hrvatski (Learn L3): T1 ponovni bet, T2 obrana na turnu,
 * T3 turn u 3-bet potovima. Ista struktura kao `t.en.ts`, s istim brojevima
 * (decimalni zarez) i istim `checks`; poker riječi ostaju one kojima se služe
 * hrvatski igrači.
 */
export const tHr: LessonBodies<
  | "turn-card-classes"
  | "double-barreling"
  | "turn-sizing-and-overbets"
  | "turn-after-flop-checks-through"
  | "facing-turn-barrels"
  | "turn-check-raise-and-probe"
  | "3bp-turn"
> = {
  "turn-card-classes": {
    sections: [
      {
        heading: "Četiri vrste karte na turnu",
        blocks: [
          "Na flopu je bilo beta i calla, i dolazi četvrta karta. Prije nego što razmisliš o svojoj ruci, pitaj što ta karta radi dvama rasponima. Većina karata na turnu spada u jednu od četiri vrste.",
          {
            list: [
              "Overkarta: viša od svih karata na flopu. Preflop raiser drži više visokih karata, pa obično pomaže raiseru.",
              "Karta koja zatvara draw: treća karta iste boje ili karta koja popunjava očitu skalu. Pomaže onome tko drži više drawova koji su callali flop, obično calleru.",
              "Karta koja uparuje board: uparuje jednu od karata s flopa. Pojavljuje se malo novih jakih ruku, a ruke koje su bile ispred uglavnom ostaju ispred.",
              "Niski blank: ispod boarda i ni s čim povezan. Malo se mijenja, a priča s flopa se nastavlja.",
            ],
          },
          "Ti nazivi opisuju raspone, a ne tvoju ruku. Karta koja zatvara draw može biti sjajna za tebe ako držiš boju; i dalje je loša karta za raspon raisera, i caller to zna.",
        ],
      },
      {
        heading: "Što Railova rješenja turna rade s njima",
        blocks: [
          "Rail je na mnogo boardova riješio turn buttona nakon što je njegov bet na flopu dobio call, a big blind checkao. Obrazac je jasan: button najčešće beta kad turn upari board ili donese overkartu, a najrjeđe kad na board stavi treću kartu iste boje. Na toj karti checkaju čak i mnogi top parovi: još jedna karta te boje slaže boje callera, pa bi bet dobio call od njih, a ostalo bi foldalo.",
          "Ruke bez ičega puno betaju na dobrim kartama: overkarta koju big blind rijetko drži, ili karta koja uparuje board i ništa ne mijenja, dopušta blefu da predstavlja jaki dio raspona raisera.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Kd", "8c", "3d", "As"] },
            caption:
              "Ilustrativni rasponi napisani za učenje, a ne Railovi chartovi: K♦8♣3♦ s A♠ na turnu. Promijeni turn na 5♦ i gledaj kako se prednost raisera smanjuje.",
          },
          {
            checkpoint: {
              question: "Button je betao K♠8♦3♦, a big blind je callao. Na kojem turnu button najrjeđe beta kad mu se checka?",
              options: ["A♣", "3♣", "5♦", "2♠"],
              answer: 2,
              explain:
                "5♦ stavlja tri karoa na board. Raspon s kojim big blind calla drži mnogo drawova na karo koji su upravo stigli, dok raspon buttona ima više visokih karata i parova, kojima pogoduju as i trica koja uparuje board. Blank dvojka malo mijenja.",
            },
          },
        ],
      },
      {
        heading: "Prebroji što karta slaže",
        blocks: [
          "Prednost u nutsu na turnu se pomiče brže od prednosti raspona. Karta koja zatvara draw odmah pretvara drawove u najbolje ruke, a možeš prebrojiti koliko ih je.",
          "Nakon flopa s dva karoa u špilu je ostalo deset karoa. Bilo koja dva od njih slažu boju kad padne treći karo: 10 × 9 / 2 = 45 kombinacija prije nego što se primijene rasponi. Raspon callera zadržava puno više tih suited ruku nego što ih raspon openera odbacuje, i zato je ta karta dobra za callera.",
          "Karta koja uparuje board radi obrnuto: trips ili full house slaže samo malobrojnim rukama koje drže taj rang, a overpairovi i top parovi raisera ostaju gdje su bili.",
        ],
      },
      {
        heading: "Vježba",
        blocks: [
          "Najprije razvrstaj karte na turnu na rasponima za učenje, a zatim igraj turn buttona na pravim rješenjima i vidi gdje Rail nastavlja betati.",
          {
            note: {
              tone: "approximate",
              text: "Razvrstavanje karata koristi ručno napisane raspone za učenje iz knjižnice koncepata. Vježbe na turnu rješavaju se na zahtjev iz raspona chartova suženih kroz flop Railovim heurističkim modelom, s jednom veličinom beta na turnu, tri četvrtine pota.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Imenuj vrstu karte prije svoje ruke: overkarta, karta koja zatvara draw, karta koja uparuje board ili blank.",
        "Kao raiser nastavi betati najviše na overkartama i kartama koje uparuju board; uspori na karti koja zatvara očiti draw.",
        "Na karti koja zatvara draw čak i dobre ruke s jednim parom često checkaju.",
        "Ruke bez showdown valuea najbolji su blefovi na kartama koje pogoduju tvom rasponu.",
      ],
      breaks: [
        "Kad tvoja ruka drži kartu koja zatvara draw, pravilo raspona popušta: betaj je za value.",
        "Protiv callera koji nikad ne igra drawove na boju treća karta iste boje bliža je blanku.",
      ],
    },
    exercises: {
      "turn-cards": "Osam turnova na rasponima za učenje: pomaže li karta raiseru, calleru ili nikome? Očitano Railovim kalkulatorom equityja.",
      "barrel-by-card": "Četiri turna na kojima si betao flop, dobio call i check: bet ili check, ocijenjeno Railovim rješenjem turna.",
      "your-hands": "Tvoje prve odluke na turnu, najskuplje prve.",
    },
    checks: [
      { fn: "product", args: [10, 9], value: 90 },
      { fn: "ratio", args: [90, 2], value: 45 },
    ],
  },

  "double-barreling": {
    sections: [
      {
        heading: "Koliko košta drugi barrel",
        blocks: [
          "Button je otvorio na 2,5 bb, big blind je callao, button je betao 1,8 bb na flopu i dobio call. Pot na turnu je 5,5 + 1,8 + 1,8 = 9,1 bb, a iza je 100 − 2,5 − 1,8 = 95,7 bb.",
          "Bet na turnu od tri četvrtine pota je oko 6,8 bb. Kao čisti blef treba foldove u 6,8 / (9,1 + 6,8) slučajeva, oko 42,8 %: opet [[bluffing-math-alpha-mdf|alfa]], i puno više od otprilike četvrtine koju je trebao mali bet na flopu. Raspon big blinda sada je i jači: njegove najslabije ruke foldale su na flopu.",
          "Zato bet na turnu mora zaraditi više od foldova. Value ruke žele call od slabijih; blefovi trebaju ili karte koje pogoduju tvom rasponu ili vlastiti equity kad dobiju call.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 9.1, bet: 6.8, share: 0.45 },
            caption: "Bet od 6,8 bb na turnu u 9,1 bb. Pomakni udio foldova da vidiš gdje blef bez equityja počinje zarađivati.",
          },
        ],
      },
      {
        heading: "Koje ruke nastavljaju betati",
        blocks: [
          "U Railovim rješenjima turna buttona nakon calla na flopu klase se jasno dijele.",
          {
            list: [
              "Setovi i druge jake ruke betaju većinu vremena, osim ako karta zatvara drawove callera: žele da pot naraste prije rivera.",
              "Drawovi često betaju: dobivaju kad big blind folda, a i dalje se popravljaju kad calla.",
              "Ruke bez para i bez drawa puno betaju na kartama koje pogoduju buttonu, a odustaju na onima koje ne pogoduju.",
              "Srednji parovi i slabi top parovi najviše checkaju: pobjeđuju blefove koji bi callali, a gube od ruku koje bi callale.",
            ],
          },
          {
            checkpoint: {
              question: "Button je betao Q♠7♦3♣ i dobio call. Turn je 2♥ i big blind checka. Koja je ruka najprirodniji check?",
              options: ["Q♣Q♥", "J♠T♠", "7♠6♠", "A♦K♦"],
              answer: 2,
              explain:
                "Dame žele value. J♠T♠ nema par ni draw, pa može dobiti samo betom. A♦K♦ nema par, ali ima dvije overkarte i malo showdown valuea: Rail ga miješa. 7♠6♠ je srednji par: bet dobiva call od boljih parova i tjera na fold ruke koje pobjeđuje, pa checka i pokušava doći do showdowna.",
            },
          },
        ],
      },
      {
        heading: "Isplaniraj river prije beta",
        blocks: [
          "Drugi barrel početak je plana, a ne njegov kraj. Prije beta znaj na kojim ćeš riverima ponovno betati, a na kojima odustati. Blef koji ne može nastaviti na većini rivera ima samo jedan street foldova za osvojiti, a cijena gore kaže da ih treba puno.",
          "Blockeri pomažu birati između blefova koji izgledaju slično: ruka koja drži kartu potrebnu big blindu za njegove najbolje callove uklanja dio njih. Lekcija R1 to broji kako treba; na turnu je to odlučujući faktor u tijesnim slučajevima, a ne razlog.",
        ],
      },
      {
        heading: "Vježba",
        blocks: [
          "Podjela prikazuje cijeli raspon buttona na jednom turnu, nakon što je njegov bet na flopu dobio call, a big blind checkao, po kategoriji ruke. Zatim vježbe dijele pojedinačne ruke tamo gdje Railovo rješenje miješa.",
          {
            note: {
              tone: "approximate",
              text: "Rješenja turna na zahtjev: rasponi chartova suženi kroz flop Railovim heurističkim modelom, s jednom veličinom beta na turnu (tri četvrtine pota) i all-inom kad su stackovi kratki.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Blef na turnu od tri četvrtine pota treba oko 43 % foldova; daj mu equity ili dobru kartu.",
        "Betaj turn s jakim rukama i drawovima; od većine srednjih parova odustani.",
        "Air beta na kartama koje pogoduju tvom rasponu, a checka na onima koje pogoduju calleru.",
        "Odluči na kojim ćeš riverima betati prije nego što betaš turn.",
      ],
      breaks: [
        "Protiv big blinda koji calla turn s bilo kojim parom betaj manje blefova, a više tankog valuea.",
        "Protiv onoga koji previše folda na drugi bet barrelaj više svog aira na bilo kojoj karti.",
      ],
    },
    exercises: {
      "barrel-split": "Dva turna nakon što je tvoj bet na flopu dobio call, a big blind checkao: stavi svaku klasu ruku u check ili bet, ocijenjeno klasu po klasu.",
      "barrel-turns": "Pet turnova na kojima dobivaš check nakon calla na flopu, dijeljene ruke tamo gdje Railovo rješenje miješa: bet ili check?",
      "your-hands": "Tvoje prve odluke na turnu kao preflop raiser u single-raised potovima, najskuplje prve.",
    },
    checks: [
      { fn: "sum", args: [5.5, 1.8, 1.8], value: 9.1 },
      { fn: "sum", args: [100, -2.5, -1.8], value: 95.7 },
      { fn: "product", args: [0.75, 9.1], value: 6.8, tolerance: 0.03 },
      { fn: "alpha", args: [9.1, 6.8], value: 0.428 },
    ],
  },

  "turn-sizing-and-overbets": {
    sections: [
      {
        heading: "Veličina koja uvodi stackove",
        blocks: [
          "Veličina ima zadatak: uvesti pravu količinu novca do rivera. S 9,1 bb u potu i 95,7 bb iza, kao u prošloj lekciji, koliko velika moraju biti dva jednaka beta da sve uđe do rivera? Svaki callani bet od f puta pot povećava pot 1 + 2f puta, pa dva takva trebaju (1 + 2f)² = 1 + 2 × 95,7 / 9,1. To je oko 1,85 puta pot na svakom streetu.",
          "Dakle, u single-raised potu sa 100 bb betovi od tri četvrtine pota ne uvode stackove do rivera. To mogu samo overbetovi. Raspon koji želi igrati za stackove — nuts i blefovi koji idu uz njega — treba velike veličine; raspon srednjih ruku uopće ne želi stackove u potu.",
          {
            widget: { id: "spr", pot: 9.1, stack: 95.7 },
            caption: "Turn u single-raised potu. Postavi broj streetova na dva da vidiš bet koji uvodi stackove do rivera, a zatim probaj 3-bet pot iz lekcije T3.",
          },
        ],
      },
      {
        heading: "Kad overbet ima smisla",
        blocks: [
          "Overbet puno traži od drugog igrača i nikome ne daje dobru cijenu: radi kad tvoj raspon drži ruke koje njegov ne može držati, pa se njegovi bluff-catcheri suočavaju s nutsom i moraju foldati ili platiti. To se događa kad je njegov raspon capped, nakon što je na ranijim streetovima checkao ili callao malo, a karta ili linija ostavila je tebi najjače ruke.",
          "Railovo rješenje rivera ima veličinu iznad pota i pokazuje obrazac: u poziciji nakon checka overbeta primjetno češće nego izvan pozicije kad je prvi na potezu, a ruke s kojima overbeta su one najjače i blefovi, a ne srednje.",
          {
            checkpoint: {
              question: "Gdje Railovo rješenje rivera češće overbeta?",
              options: ["U poziciji, nakon što drugi igrač checka", "Izvan pozicije, kao prvi na potezu", "Otprilike jednako u oba slučaja"],
              answer: 0,
              explain:
                "Check capa raspon koji ga je napravio: drži manje najjačih ruku, jer bi mnoge od njih betale. Igrač u poziciji tada drži više nutsa u odnosu na raspon nasuprot sebi, a upravo to overbet treba.",
            },
          },
          "Overbet blefove biraj na isti način: ruke koje drže karte najboljih callova drugog igrača, a nijednu kartu koja treba njegovim rukama koje foldaju.",
        ],
      },
      {
        heading: "Srednje ruke checkaju",
        blocks: [
          "Druga strana polariziranog turna je check. Srednji parovi i slabi top parovi malo dobivaju od velikog beta: bolje ruke ga callaju, slabije foldaju. U Railovim rješenjima turna oni su među klasama koje najviše checkaju, čime pot ostaje malen, a njihov showdown value živ.",
          {
            note: {
              tone: "approximate",
              text: "Railovo stablo turna ima jednu veličinu beta, tri četvrtine pota, plus all-in kad su stackovi kratki, pa se overbetovi na turnu ovdje uče računicom i rješenjem rivera, koje ima veličinu od 150 %. Podjela na riveru ispod ocjenjuje se s tom veličinom kao zasebnom grupom.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Biraj veličinu prema stackovima: izračunaj koliko veliki betovi moraju biti da ih uvedu do rivera.",
        "Overbetaj kad je drugi raspon capped, a tvoj drži nuts.",
        "Overbet blefovi drže karte ruku koje bi callale.",
        "Srednje ruke checkaju i drže pot malim.",
      ],
      breaks: [
        "Protiv igrača koji nikad ne folda par overbetaj samo za value.",
        "Kad su stackovi već kratki, overbet je jednostavno all-in: nema više veličine za birati.",
      ],
    },
    exercises: {
      "size-the-turn": "Četiri turna nakon calla na flopu, s checkom prema tebi: check, bet od tri četvrtine pota ili all-in, ocijenjeno Railovim rješenjem turna.",
      "overbet-split": "Dva rivera u poziciji nakon checka: stavi svaku klasu ruku u check, mali, veliki bet ili overbet, ocijenjeno Railovim rješenjem rivera.",
      "your-hands": "Tvoje odluke na turnu gdje bi Rail betao, najskuplje prve.",
    },
    checks: [
      { fn: "geometricBet", args: [9.1, 95.7, 2], value: 1.85, tolerance: 0.005 },
    ],
  },

  "turn-after-flop-checks-through": {
    sections: [
      {
        heading: "Dva capped raspona",
        blocks: [
          "Kad big blind checka, a button checka iza, oba raspona su nešto izgubila. Button beta većinu svojih jakih ruku na flopu, pa ih njegov raspon checkova drži manje. Big blind je prvi checkao sa svime, pa mu je raspon širok, ali ni on nije leadao sa svojim najboljim rukama.",
          "Tko od toga dobiva ovisi o sljedećoj karti i o tome što svaki raspon još skriva. Checkovi buttona i dalje drže nešto jakih ruku zadržanih namjerno; raspon big blinda nije capped, ali je pun slabih ruku.",
        ],
      },
      {
        heading: "Bet u poziciji nakon checka",
        blocks: [
          "Kad big blind ponovno checka na turnu, Railovo rješenje daje buttonu da često beta: češće nego na mnogim turnovima nakon calla na flopu. Njegov raspon je capped, ali raspon big blinda pokazao je dva checka i drži mnogo ruku koje ne podnose bet.",
          "Cijena je ona s flopa: bet od tri četvrtine pota od 5,5 bb je oko 4,1 bb, i kao čisti blef treba oko 42,7 % foldova. Protiv raspona koji je dvaput checkao često ih i dobije.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 5.5, bet: 4.1, share: 0.45 },
            caption: "Bet od 4,1 bb na turnu u 5,5 bb nakon što je flop prošao check-check. Pomakni udio foldova da vidiš gdje zarađuje.",
          },
        ],
      },
      {
        heading: "Lead izvan pozicije",
        blocks: [
          "Lead na turnu nakon što je flop prošao check-check zove se probe. U Railovim rješenjima turna big blind rijetko leada, čak i ovdje: ruke koje najčešće leadaju su složene skale i jaki drawovi, a ostatak raspona checka i pušta buttona da beta.",
          {
            checkpoint: {
              question: "Flop je prošao check-check. Što u Railovom rješenju turna većina raspona big blinda radi prva na turnu?",
              options: ["Leada tri četvrtine pota", "Checka", "Ide all-in"],
              answer: 1,
              explain:
                "Button često beta kad mu se checka, pa slabe i srednje ruke big blinda malo gube checkom i nakon toga mogu callati ili foldati. Lead se čuva za ruke koje žele odmah graditi pot.",
            },
          },
          "Protiv beta buttona big blind se brani kao i inače: protiv 4,1 bb u 5,5 bb [[bluffing-math-alpha-mdf|minimalna obrana]] je 5,5 / 9,6, oko 57 % raspona koji je checkao.",
          {
            note: {
              tone: "approximate",
              text: "Railovo stablo turna ima jednu veličinu beta, tri četvrtine pota. Manji probe betovi, koje mnogi igrači koriste, nisu u njemu, pa je odluka rješenja da rijetko leada zapravo izbor između checka i velikog leada.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Nakon što flop prođe check-check, u poziciji često betaj turn kad ti se opet checka.",
        "Blef od tri četvrtine pota i dalje treba oko 43 % foldova; dva checka ih često osiguraju.",
        "Izvan pozicije leadaj samo s rukama koje žele velik pot odmah; ostalo checkaj.",
        "Brani se protiv beta na turnu barem s udjelom koji traži minimalna obrana.",
      ],
      breaks: [
        "Protiv big blinda koji često check-raisea turn checkaj iza više srednjih ruku.",
        "Protiv buttona koji nikad ne beta nakon dva checka leadaj svoj tanki value sam.",
      ],
    },
    exercises: {
      "delayed-bets": "Četiri turna nakon što je flop prošao check-check, a big blind ponovno checkao: bet ili check, ocijenjeno Railovim rješenjem turna.",
      "probe-split": "Dva turna kao big blind nakon što je flop prošao check-check: stavi svaku klasu ruku u check ili bet, ocijenjeno klasu po klasu.",
      "your-hands": "Tvoje prve odluke na turnu nakon checkanog flopa u single-raised potovima, najskuplje prve.",
    },
    checks: [
      { fn: "product", args: [0.75, 5.5], value: 4.1, tolerance: 0.03 },
      { fn: "alpha", args: [5.5, 4.1], value: 0.427 },
      { fn: "mdf", args: [5.5, 4.1], value: 0.57, tolerance: 0.005 },
      { fn: "sum", args: [5.5, 4.1], value: 9.6 },
    ],
  },

  "facing-turn-barrels": {
    sections: [
      {
        heading: "Cijena drugog barrela",
        blocks: [
          "Callao si bet na flopu; pot na turnu je 9,1 bb, a raiser beta tri četvrtine toga, 6,8 bb. Call ulaže 6,8 da osvoji pot od 9,1 + 6,8 + 6,8 = 22,7 bb: trebaš [[pot-odds|pot odds]] od 6,8 / 22,7, oko 30 % equityja, ako više novca ne uđe.",
          "Minimalna obrana je 9,1 / 15,9, oko 57 %: udio tvog raspona koji mora nastaviti da čisti blef ne može zaraditi. To je vodič, a ne pravilo. Raspon raisera na turnu nisu samo blefovi, a pred tobom je još river, gdje pozicija odlučuje koliko svog equityja zadržavaš.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 15.9, bet: 6.8 },
            caption: "Call od 6,8 bb u pot od 15,9 bb s betom u njemu. Promijeni veličinu beta da vidiš kako se cijena mijenja.",
          },
        ],
      },
      {
        heading: "Koje ruke nastavljaju callati",
        blocks: [
          "U Railovim rješenjima turna, protiv beta od tri četvrtine pota, klase se brane jasnim redom: top parovi callaju gotovo uvijek, srednji parovi često, slabi parovi češće foldaju nego callaju, gutshotovi uglavnom foldaju, a ruke bez para foldaju. Najzanimljivija linija su drawovi.",
          {
            checkpoint: {
              question: "Izvan pozicije protiv beta na turnu od tri četvrtine pota, koju ruku Railovo rješenje najčešće folda?",
              options: ["Draw na boju", "Srednji par", "Top par"],
              answer: 0,
              explain:
                "S još jednom kartom draw na boju ima 9 outova od 46 karata, oko 19,6 %, manje od 30 % koje traži cijena. U poziciji može callati češće, jer beta kad pogodi i checka kad promaši; izvan pozicije plaća cijenu i kad pogodi često ne dobije više.",
              math: { fn: "ratio", args: [9, 46], value: 0.196 },
            },
          },
          "To je realizacija equityja na turnu: isti draw u poziciji je call, a izvan pozicije često fold.",
        ],
      },
      {
        heading: "Capped rasponi čine male parove callom",
        blocks: [
          "Tko beta turn jednako je važno kao veličina. Raiser koji je checkao flop pa betao turn drži manje jakih ruku od onoga koji je betao dvaput; protiv takvog capped raspona niski parovi dobivaju na vrijednosti kao bluff-catcheri. Čitaj liniju, zatim veličinu, zatim svoju ruku.",
          {
            note: {
              tone: "approximate",
              text: "Rješenja turna na zahtjev: rasponi chartova suženi kroz flop Railovim heurističkim modelom, s jednom veličinom beta na turnu, tri četvrtine pota, i all-inom kad su stackovi kratki.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Protiv tri četvrtine pota trebaš oko 30 % equityja, a oko 57 % tvog raspona mora nastaviti.",
        "Top parovi callaju; srednji parovi miješaju; slabi parovi i ruke bez para uglavnom foldaju.",
        "Drawovi callaju više u poziciji nego izvan nje.",
        "Pročitaj tko je betao i kako prije nego što procijeniš svoju ruku: capped linije čine male parove callom.",
      ],
      breaks: [
        "Protiv igrača koji barrela samo s jakim rukama foldaj više iz sredine.",
        "Protiv onoga koji barrela svaki turn callaj više iz sredine i nešto slabih parova.",
      ],
    },
    exercises: {
      "defend-split": "Dva turna izvan pozicije nakon što si callao bet na flopu, a na turnu je bet: stavi svaku klasu ruku u fold, call ili raise, ocijenjeno klasu po klasu.",
      "turn-barrels": "Pet turnova u poziciji protiv beta kao preflop caller: fold, call ili raise, ocijenjeno Railovim rješenjem turna.",
      "your-hands": "Tvoje odluke na turnu protiv beta, najskuplje prve, i turnovi označeni zbog calla bez cijene.",
    },
    checks: [
      { fn: "sum", args: [9.1, 6.8, 6.8], value: 22.7 },
      { fn: "requiredEquity", args: [15.9, 6.8], value: 0.2996, tolerance: 0.005 },
      { fn: "mdf", args: [9.1, 6.8], value: 0.57, tolerance: 0.005 },
      { fn: "sum", args: [9.1, 6.8], value: 15.9 },
    ],
  },

  "turn-check-raise-and-probe": {
    sections: [
      {
        heading: "Check-raise na turnu",
        blocks: [
          "Izvan pozicije protiv beta na turnu najjači potez je check-raise. To je ujedno i najskuplji potez, a Railova rješenja drže ga uskim: big blind raisea uglavnom sa skalama, setovima i dva para, a pridružuje im se tek nekoliko jakih drawova.",
          "Razlog su stackovi. Raise na turnu u single-raised potu priprema all-in na riveru; draw koji raisea i promaši mora odustati od velikog pota ili blefirati ostatak. Jake složene ruke raiseaju jer žele sav novac u potu, a i kad dobiju call i dalje dobivaju.",
          {
            checkpoint: {
              question: "Izvan pozicije protiv beta na turnu od tri četvrtine pota, s kojom rukom Railovo rješenje najčešće raisea?",
              options: ["Skala", "Draw na boju", "Top par"],
              answer: 0,
              explain:
                "Skala želi uvesti stackove i rijetko je iza. Draw na boju izvan pozicije uglavnom calla ili folda, a top par calla: pobjeđuje blefove i slabije parove, a raise bi dobio call samo od boljih.",
            },
          },
        ],
      },
      {
        heading: "Lead na turnu",
        blocks: [
          "Lead u raisera na turnu — nakon calla na flopu ili nakon što je flop prošao check-check — mali je dio zdrave strategije. U Railovim rješenjima rijedak je u obje linije, a ruke koje leadaju su one koje žele velik pot odmah: jake složene ruke koje su se popravile i najjači drawovi.",
          "Sve ostalo checka: raiser beta dovoljno često da obavi posao, a tvoje srednje ruke zadržavaju showdown value.",
        ],
      },
      {
        heading: "Veličina prema stackovima iza",
        blocks: [
          "Kad leadaš ili raiseaš da izgradiš pot, odredi veličinu tako da stackovi uđu do rivera. Recimo da je u potu 20 bb, a iza 40 bb. Dva jednaka beta od f puta pot uvode sve kad je (1 + 2f)² = 1 + 2 × 40 / 20 = 5, što je oko 62 % pota na svakom streetu.",
          "Ista računica, s dubljim stackovima, objašnjava zašto je raise na turnu u single-raised potu tako velika obveza: s gotovo 100 bb iza to je jedini preostali street na kojem pot može narasti prije shovea na riveru.",
          {
            widget: { id: "spr", pot: 20, stack: 40 },
            caption: "20 bb u potu i 40 bb iza. Postavi broj streetova na dva da vidiš bet koji uvodi stackove.",
          },
          {
            note: {
              tone: "approximate",
              text: "Railovo stablo turna ima jednu veličinu beta i jednu veličinu raisea, svaku od tri četvrtine pota, plus all-in. Manji leadovi i raiseovi ovdje se uče riječima.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Check-raiseaj turn uglavnom s jakim složenim rukama, plus nekoliko najjačih drawova.",
        "Leadaj turn rijetko: samo s rukama koje žele velik pot odmah.",
        "Srednje ruke check-callaj; pusti raisera da beta.",
        "Leadove i raiseove odmjeri tako da stackovi uđu do rivera.",
      ],
      breaks: [
        "Protiv raisera koji barrela svaki turn check-raiseaj nešto više drawova.",
        "Protiv onoga koji previše checka iza leadaj više svog tankog valuea.",
      ],
    },
    exercises: {
      "turn-fold-call-raise": "Dva turna izvan pozicije protiv beta: stavi svaku klasu ruku u fold, call ili raise, ocijenjeno klasu po klasu prema Railovom rješenju turna.",
      "probe-or-check": "Četiri turna izvan pozicije kao preflop caller, prvi na potezu, dijeljene ruke tamo gdje rješenje miješa: bet ili check?",
      "your-hands": "Tvoje odluke na turnu izvan pozicije kao preflop caller, najskuplje prve.",
    },
    checks: [
      { fn: "geometricBet", args: [20, 40, 2], value: 0.62, tolerance: 0.005 },
    ],
  },

  "3bp-turn": {
    sections: [
      {
        heading: "Malo iza, velik pot",
        blocks: [
          "Big blind 3-beta buttona na 10 bb i dobiva call: 20,5 bb u potu, 90 bb iza, SPR oko 4,4. Bet na flopu od trećine pota, 6,8 bb, dobiva call. Pot na turnu je 34,1 bb, a iza je 83,2 bb: SPR oko 2,4.",
          "Sada je bet na turnu od tri četvrtine pota oko 25,6 bb. Ako dobije call, pot na riveru je 85,3 bb, a iza 57,6 bb, SPR oko 0,68: bet na riveru je all-in za manje od pota. Odluka na turnu je odluka o stackovima.",
          {
            widget: { id: "spr", pot: 34.1, stack: 83.2 },
            caption: "3-bet pot na turnu. Postavi broj streetova na dva: bet koji uvodi stackove nije daleko od tri četvrtine pota.",
          },
        ],
      },
      {
        heading: "Barrel ili odustajanje",
        blocks: [
          "Railova rješenja turna 3-bettora pokazuju istu podjelu kao u single-raised potovima, samo oštriju. Top parovi i bolje češće betaju nego checkaju; ruke bez para i bez showdown valuea puno betaju; srednji parovi većinu vremena checkaju. S tako malo iza srednja ruka koja beta i dobije raise nema kamo.",
          {
            checkpoint: {
              question: "3-bettor dobiva check na turnu s otprilike 2,4 puta pot iza. Koja je ruka najprirodniji check?",
              options: ["Overpair", "Srednji par", "As-kralj bez para i bez drawa"],
              answer: 1,
              explain:
                "Overpair želi uvesti stackove i stiže do toga betom na turnu i shoveom na riveru. As-kralj nema showdown valuea, ali ima dvije overkarte: može betati i osvojiti pot, ili se popraviti. Srednji par pobjeđuje samo blefove i ne podnosi raise s ovako kratkim stackovima, pa checka.",
            },
          },
        ],
      },
      {
        heading: "Obrana turna kao caller",
        blocks: [
          "Protiv beta na turnu od 25,6 bb u 34,1 bb minimalna obrana je 34,1 / 59,7, oko 57 %. Railova rješenja brane se top parovima i jakim drawovima, raiseaju najjače ruke, a foldaju većinu srednjih i slabih parova: s all-inom na riveru koji slijedi, call sada često je call za stackove.",
          {
            note: {
              tone: "approximate",
              text: "Rješenja turna na zahtjev: 3-bet rasponi i rasponi za call iz chartova, suženi kroz flop Railovim heurističkim modelom, s jednom veličinom beta na turnu, tri četvrtine pota, i all-inom kad su stackovi kratki.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "U 3-bet potu izračunaj SPR na turnu: blizu 2, bet na turnu priprema all-in na riveru.",
        "Barrelaj jake ruke i air; srednje parove checkaj.",
        "Brani se top parovima i jakim drawovima; većina srednjih parova folda.",
        "Na turnu odluči igraš li za stackove.",
      ],
      breaks: [
        "Dublji stackovi (3-bet pot sa 150 bb ili više) ostavljaju mjesta za treći street i više checkiranja.",
        "Protiv callera koji nikad ne folda turn betaj manje blefova, a više srednjeg valuea.",
      ],
    },
    exercises: {
      "3bp-turn-split": "Dva turna u 3-bet potu, ti si 3-bettor u poziciji nakon checka: stavi svaku klasu ruku u check ili bet, ocijenjeno klasu po klasu.",
      "3bp-turns": "Pet turnova u 3-bet potovima, u bilo kojoj ulozi, ocijenjeno Railovim rješenjem turna.",
      "your-hands": "Tvoje odluke na turnu u 3-bet potovima, najskuplje prve.",
    },
    checks: [
      { fn: "sum", args: [10, 10, 0.5], value: 20.5 },
      { fn: "spr", args: [90, 20.5], value: 4.4, tolerance: 0.05 },
      { fn: "product", args: [0.33, 20.5], value: 6.8, tolerance: 0.05 },
      { fn: "sum", args: [20.5, 6.8, 6.8], value: 34.1 },
      { fn: "sum", args: [90, -6.8], value: 83.2 },
      { fn: "spr", args: [83.2, 34.1], value: 2.4, tolerance: 0.05 },
      { fn: "product", args: [0.75, 34.1], value: 25.6, tolerance: 0.03 },
      { fn: "sum", args: [34.1, 25.6, 25.6], value: 85.3 },
      { fn: "sum", args: [83.2, -25.6], value: 57.6 },
      { fn: "spr", args: [57.6, 85.3], value: 0.68, tolerance: 0.005 },
      { fn: "sum", args: [34.1, 25.6], value: 59.7 },
      { fn: "mdf", args: [34.1, 25.6], value: 0.57, tolerance: 0.005 },
    ],
  },
};

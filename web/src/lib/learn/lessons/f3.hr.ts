import type { LessonBodies } from "./types";

/**
 * F3 — single-raised potovi, caller, hrvatski (Learn L2). Ista struktura
 * kao `f3.en.ts`, isti `checks`.
 */
export const f3Hr: LessonBodies<"defending-vs-cbets" | "check-raising" | "floating-and-stabbing-ip" | "probes-and-donk-bets" | "bb-vs-btn-blueprint"> = {
  "defending-vs-cbets": {
    sections: [
      {
        heading: "Alfa i MDF, ondje gdje odlučuju",
        blocks: [
          "Button beta u tvoj big blind. Odluku uokviruju dva broja. [[bluffing-math-alpha-mdf|Alfa]], bet ÷ (pot + bet), govori koliko često čisti blef mora uspjeti. MDF, 1 − alfa, govori koliki dio tvog raspona mora nastaviti da taj blef prestane zarađivati.",
          {
            list: [
              "Bet od trećine pota, 1 u 3: alfa 1 / 4 = 25 %, MDF 75 %. Tvoj call je 1 da osvojiš 4: trebaš 1 / 5 = 20 % equityja.",
              "Bet od tri četvrtine, 3 u 4: alfa 3 / 7, oko 42,9 %, MDF oko 57,1 %. Tvoj call treba 3 / 10 = 30 %.",
            ],
          },
          "Mali betovi, dakle, traže da nastaviš s puno većim dijelom raspona, i daju ti puno bolju cijenu za to.",
          {
            checkpoint: {
              question: "Button beta trećinu pota. Koliki dio tvog raspona prema minimalnoj obrani mora nastaviti?",
              options: ["Oko 57 %", "75 %", "80 %"],
              answer: 1,
              explain: "Trećina pota je 1 u 3: alfa je 1 / (3 + 1) = 25 %, pa je minimalna obrana preostalih 75 %.",
              math: { fn: "mdf", args: [3, 1], value: 0.75 },
              reveal: { id: "bet-math", focus: "mdf", pot: 3, bet: 1, share: 0.75 },
            },
          },
        ],
      },
      {
        heading: "Zašto big blind folda više od toga",
        blocks: [
          "U Railovim rješenjima big blinda protiv buttona big blind folda više nego što minimalna obrana kaže, najviše protiv malih betova. To nije proturječje. Minimalna obrana je točka na kojoj bet bez equityja prestaje zarađivati; branitelj čiji raspon ima mnogo ruku gotovo bez equityja ne može je dosegnuti a da ne calla i s tim rukama, a callovi s njima gube više nego što blefovi dobivaju.",
          "To objašnjava i drugu stranu: budući da se big blind ne može dovoljno braniti, button zarađuje betajući mnogo ruku. Minimalnu obranu shvati kao žaruljicu upozorenja, a ne kao cilj. Ako foldaš puno više od nje, pitaj se jesu li tvoji foldovi ruke koje stvarno nisu imale ništa.",
        ],
      },
      {
        heading: "Što nastavlja protiv malog beta",
        blocks: [
          {
            list: [
              "Većina parova nastavlja, uglavnom callom; najslabiji češće foldaju na boardovima koji pogoduju raiseru, primjerice onima s asom. Najbolji top parovi, dva para i setovi često raiseaju.",
              "Svaki pravi draw nastavlja: drawovi na boju i otvoreni drawovi na skalu callaju ili raiseaju, gutshotovi uglavnom nastavljaju.",
              "As kao najviša karta ponekad nastavlja, češće s backdoor drawom ili gutshotom.",
              "Bez para, bez drawa: fold. Sami backdoor drawovi rijetko nose ruku; oni odlučuju tijesne slučajeve.",
            ],
          },
          "Protiv velikog beta vrijedi isti redoslijed s granicom pomaknutom gore: najslabiji parovi i slabiji asovi bez para prvi ispadaju.",
          {
            checkpoint: {
              question: "Big blind protiv malog beta buttona na K♠8♦4♣. Koja je ruka najjasniji fold?",
              options: ["5♥5♦", "7♦6♦", "Q♥3♥"],
              answer: 2,
              explain:
                "Petice su par: pobjeđuju blefove buttona i nastavljaju. 7♦6♦ ima gutshot na peticu i backdoor draw na karo. Q♥3♥ nema par ni ikakav draw, čak ni backdoor: rijetko dobiva kad calla i ne podnosi novi bet.",
            },
          },
        ],
      },
      {
        heading: "Cijena i realizacija",
        blocks: [
          "Call treba više od gole cijene. Izvan pozicije nećeš uvijek vidjeti river, a dio tvog equityja je u rukama koje će foldati na kasnije betove. To je [[equity-realisation-and-implied-odds|realizacija]]: ruka s 20 % equityja protiv beta od trećine pota nije automatski call ako rijetko može doći do showdowna.",
          {
            note: {
              tone: "approximate",
              text: "Vježbe se dijele iz Railove knjižnice flopova, kombinacija po kombinaciju. Tvoje ruke na flopovima koje knjižnica nije riješila čitaju se s najbližeg riješenog flopa po kategoriji ruke, a analiza ih označava kao mapirane.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Izračunaj [[bluffing-math-alpha-mdf|alfu i MDF]] za veličinu s kojom se suočavaš: manji betovi traže širu obranu.",
        "Protiv malog beta nastavi s većinom parova i svakim pravim drawom.",
        "Foldaj ruke bez para i bez drawa; neka backdoori odlučuju samo tijesne slučajeve.",
        "Izvan pozicije cijena nije dovoljna: procijeni koliko ćeš equityja realizirati.",
      ],
      breaks: [
        "Protiv igrača koji betaju samo jake ruke foldaj puno više od bilo kojeg vodiča za obranu.",
        "Protiv igrača koji betaju svaki flop callaj šire s asom bez para i s parovima.",
      ],
    },
    exercises: {
      "sizing-quiz": "Osam veličina beta: izračunaj alfu ili minimalnu obranu prije nego što je kalkulator pokaže.",
      "flop-defence": "Šest flopova iz Railove knjižnice protiv beta raisera: fold, call ili raise, ocijenjeno rješenjem.",
      "your-hands": "Tvoje odluke na flopu protiv beta i tvoje ruke označene zbog calla bez cijene ili folda uz dobru cijenu.",
    },
    checks: [
      { fn: "alpha", args: [3, 1], value: 0.25 },
      { fn: "requiredEquity", args: [4, 1], value: 0.2 },
      { fn: "alpha", args: [4, 3], value: 0.429 },
      { fn: "mdf", args: [4, 3], value: 0.571 },
      { fn: "requiredEquity", args: [7, 3], value: 0.3 },
    ],
  },

  "check-raising": {
    sections: [
      {
        heading: "Čemu služi check-raise",
        blocks: [
          "Check-raise obavlja dva posla odjednom. Gradi velik pot s tvojim najjačim rukama i oduzima pot širokom rasponu koji beta, s rukama koje imaju equity kad dobiju call. Bez prve vrste to je blef koji svatko može callati do kraja; bez druge to je natpis koji kaže da držiš nuts.",
          "U Railovu stablu flopa raise je pola pota nakon calla: protiv beta od trećine pota, oko 1,8 bb u 5,5 bb, raise na oko 6,35 bb. Kao blef treba oko 46,5 % foldova, pa ruke koje raiseaju kao blef žele equity za slučaj kad dobiju call.",
        ],
      },
      {
        heading: "Koje ruke raiseaju",
        blocks: [
          {
            list: [
              "Value: setovi, dva para, skale i često najbolji top parovi.",
              "Drawovi: otvoreni drawovi na skalu, kombinirani drawovi i najjači drawovi na boju raiseaju puno; gutshotovi ponekad.",
              "Ne: slabi top parovi i srednji parovi, koji callaju; i ruke bez para i bez drawa, koje foldaju.",
            ],
          },
          {
            checkpoint: {
              question: "Big blind na 8♥7♣3♦ protiv malog beta. Koja je ruka najprirodniji check-raise od onih koje već nisu jake?",
              options: ["K♣Q♣", "T♦9♦", "A♠8♦"],
              answer: 1,
              explain:
                "T♦9♦ je otvoreni draw na skalu: kad dobije call i dalje ima dosta equityja, a kad bet folda, dobiva odmah. A♠8♦ je top par s najboljim kickerom, dovoljno jak za raise zbog valuea, ali rado i calla. K♣Q♣ ima dvije overkarte i backdoor draw na boju: premalo equityja za raise.",
            },
          },
        ],
      },
      {
        heading: "Koji boardovi",
        blocks: [
          "U Railovim rješenjima big blind najviše check-raisea na niskim boardovima, uparenim boardovima i srednjim povezanima, a najmanje na boardovima s asom i jednobojnima. Razlog je vrh raspona: na niskim i povezanim boardovima big blind ima mnogo setova, dva para i skala; na boardovima s asom button ima više jakih asova, a na jednobojnim boardovima raise malo toga tjera na fold i dobiva call od boljih boja.",
          "Protiv malih betova big blind raisea češće nego protiv velikih: mali bet ostavlja više slabih ruku u rasponu buttona koje treba kazniti.",
          {
            widget: { id: "range-vs-range", focus: "nuts", preset: "btn-vs-bb", board: ["8h", "7c", "3d"] },
            caption: "Ilustrativni rasponi napisani za učenje: tko ima najjače ruke na 8♥7♣3♦.",
          },
        ],
      },
      {
        heading: "Vježba",
        blocks: [
          "Podjela stavlja cijeli tvoj raspon iz big blinda protiv malog beta na jedan od flopova iz knjižnice: svaku klasu stavi u fold, call ili raise. Zatim vježbe dijele pojedinačne ruke iz iste situacije, odabrane tamo gdje rješenje miješa.",
          {
            note: {
              tone: "approximate",
              text: "Podjela i vježbe dolaze iz Railove knjižnice flopova. Tvoje ruke na flopovima koje nije riješila čitaju se s najbližeg riješenog flopa po kategoriji ruke.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Raiseaj jake ruke zbog valuea i dobre drawove kao blefove; sredinu callaj.",
        "Raiseaj više na niskim, uparenim i povezanim boardovima; manje na boardovima s asom i jednobojnima.",
        "Raiseaj više protiv malih betova nego protiv velikih.",
        "Raise-blef želi equity kad dobije call.",
      ],
      breaks: [
        "Protiv igrača koji previše foldaju na raise raiseaj više slabijih drawova.",
        "Protiv igrača koji nikad ne foldaju overpair raiseaj manje blefova, a više tankog valuea.",
      ],
    },
    exercises: {
      "fold-call-raise": "Tri flopa iz Railove knjižnice protiv malog beta: razvrstaj svoje klase ruku na fold, call i raise.",
      "raise-or-not": "Četiri pojedinačne ruke iz iste situacije, dijeljene tamo gdje rješenje miješa: fold, call ili raise?",
      "your-hands": "Tvoje odluke iz big blinda protiv beta na flopu, najskuplje prve.",
    },
    checks: [
      { fn: "sum", args: [1.8, 4.55], value: 6.35 },
      { fn: "alpha", args: [7.3, 6.35], value: 0.465 },
    ],
  },

  "floating-and-stabbing-ip": {
    sections: [
      {
        heading: "Call u poziciji",
        blocks: [
          "Kad callaš u poziciji, flop nije posljednja prilika da osvojiš pot. Vidiš akciju raisera na turnu prije nego što odlučiš, pa ruke koje će često dobiti kasnije mogu callati sada: parovi, drawovi i overkarte s backdoorom. To je vrijednost pozicije, isplaćena kroz turn i river.",
          "Cijenu računaš isto. Small blind beta 2 bb u 6 bb, trećinu pota; ti callaš 2 da osvojiš 8 i trebaš 2 / (8 + 2) = 20 % equityja, prije nego što ubrojiš što pozicija dodaje.",
        ],
      },
      {
        heading: "Bet kad raiser checka",
        blocks: [
          "Kad ti raiser checka, njegov raspon ima manje ruku koje betaju za value, ali ne nijednu: izvan pozicije checka i neke jake ruke da zaštiti svoje checkove. Koliko često betaš uglavnom odlučuje board.",
          "U Railovim rješenjima big blinda u poziciji protiv checka small blinda big blind najčešće beta na niskim boardovima, gdje mu je raspon najjači, a najrjeđe na boardovima s asom, gdje checkovi small blinda i dalje drže mnogo asova. Check ti nešto govori; board ti govori više.",
          {
            checkpoint: {
              question: "Small blind protiv big blinda. Na kojem bi flopu big blind trebao najčešće betati nakon checka small blinda?",
              options: ["A♠J♦4♣", "6♦5♣3♥", "K♠Q♦9♥"],
              answer: 1,
              explain:
                "Small blind na 6♦5♣3♥ checka gotovo sve, a raspon big blinda ondje ima više setova, dva para i skala, pa može betati često. Na visokim boardovima checkovi small blinda i dalje skrivaju mnogo jakih asova i kraljeva, pa big blind beta manje.",
            },
          },
        ],
      },
      {
        heading: "Pošteni betovi nakon checka",
        blocks: [
          "Ako betaš samo kad nemaš ništa, raiser koji check-raisea tvoje betove dobiva svaki put. Betaj i nekoliko jakih ruku, a neke slabe ruke pusti da checkaju iza i uzmu besplatnu kartu. Mali i čest bet na boardovima koji ti pašu, s jakim rukama u njemu, težak je za igrati protiv.",
          {
            note: {
              tone: "approximate",
              text: "Vježbe na flopu dolaze iz Railove knjižnice flopova, u kojoj je big blind u poziciji protiv small blinda single-raised linija s callerom u poziciji. Vježbe na turnu rješavaju se na zahtjev iz raspona suženih kroz flop.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Callaj u poziciji s rukama koje dobivaju kasnije: parovi, drawovi, overkarte s backdoorom.",
        "Nakon checka raisera neka board odluči koliko često betaš.",
        "Betaj malo i često na boardovima koji pogoduju tvom rasponu.",
        "Stavi jake ruke u svoje betove nakon checka, da ih check-raise ne pobijedi sve.",
      ],
      breaks: [
        "Protiv raisera koji nikad ne checkaju jake ruke betaj gotovo svaki put kad checkaju.",
        "Protiv raisera koji često check-raiseaju betaj manje bez ičega, a više s rukama koje mogu callati raise.",
      ],
    },
    exercises: {
      "float-flops": "Tri flopa iz Railove knjižnice u poziciji protiv beta raisera: fold, call ili raise.",
      "stab-flops": "Tri flopa u poziciji nakon što raiser checka: check ili bet, i koliko veliko.",
      "stab-turns": "Tri turna u poziciji nakon što raiser checka, riješena na zahtjev.",
      "your-hands": "Tvoje odluke u poziciji kao caller, na flopu i turnu, najskuplje prve.",
    },
    checks: [{ fn: "requiredEquity", args: [8, 2], value: 0.2 }],
  },

  "probes-and-donk-bets": {
    sections: [
      {
        heading: "Bet ispred raisera",
        blocks: [
          "Lead na flopu izvan pozicije kao caller rijedak je u Railovim rješenjima: na većini boardova big blind checka cijeli raspon raiseru. Raspon raisera obično je jači, a check mu dopušta da beta svoj široki raspon u tebe, od čega se onda braniš.",
          "Leadovi se pojavljuju tamo gdje board pomiče vrh raspona prema calleru: na niskim boardovima, sa sedmicom i niže, i na nekim uparenim i jednobojnima. Ondje big blind ima više jakih ruku, a lead može preuzeti inicijativu mješavinom takvih ruku i drawova.",
          {
            checkpoint: {
              question: "Big blind protiv buttona. Na kojem je flopu lead najvjerojatnije dio Railove strategije?",
              options: ["K♠Q♦4♣", "5♠4♦2♣", "A♥J♣7♦"],
              answer: 1,
              explain:
                "Na 5♠4♦2♣ suited asovi, mali connectori i mali parovi big blinda slažu skale, dva para i setove koje button rijetko ima. Na dva visoka boarda button ima jače ruke, a big blind checka gotovo sve.",
            },
          },
        ],
      },
      {
        heading: "Probe na turnu",
        blocks: [
          "Češći lead dolazi street kasnije. Kad raiser checka iza na flopu, njegov je raspon capped: većina njegovih jakih ruku betala bi. Na turnu big blind može betati u taj capped raspon: value s rukama koje su ispred, blefove s drawovima i rukama koje su promašile.",
          "Najbolje karte za probe su one koje pomažu rasponu callera: niske karte i karte koje zatvaraju njegove drawove. Overkarte koje pomažu raiseru lošije su.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 5.5, bet: 4.1, share: 0.45 },
            caption: "Probe na turnu od tri četvrtine pota u 5,5 bb: kao čisti blef treba oko 43 % foldova.",
          },
        ],
      },
      {
        heading: "U Railu",
        blocks: [
          "Vježba na flopu dijeli tvoju prvu odluku kao big blind: check ili lead, ocijenjeno rješenjem knjižnice, u kojem je lead obično greška. Vježba na turnu dijeli probe nakon checkanog flopa.",
          {
            note: {
              tone: "approximate",
              text: "Vježbe na flopu su iz Railove knjižnice flopova; vježbe na turnu rješavaju se na zahtjev iz raspona suženih kroz flop. Tvoje ruke na flopovima koje knjižnica nije riješila čitaju se s najbližeg riješenog flopa.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Na većini boardova checkaj flop raiseru.",
        "Leadaj samo gdje ti board daje više jakih ruku: na niskim i nekim uparenim flopovima.",
        "Probaj turn nakon što raiser checka iza na flopu, na kartama koje pomažu tvom rasponu.",
      ],
      breaks: [
        "Protiv raisera koji previše checkaju iza probaj više turnova, i veće.",
        "Protiv raisera koji c-betaju svaki flop check je već dobar način da preuzmeš inicijativu check-raiseom.",
      ],
    },
    exercises: {
      "lead-or-check": "Četiri flopa iz Railove knjižnice, tvoja prva odluka kao caller izvan pozicije: check ili lead?",
      "probe-turns": "Tri turna izvan pozicije kao caller, riješena na zahtjev.",
      "your-hands": "Tvoje prve odluke kao caller izvan pozicije na flopu i turnu, najskuplje prve.",
    },
    checks: [{ fn: "alpha", args: [5.5, 4.1], value: 0.427 }],
  },

  "bb-vs-btn-blueprint": {
    sections: [
      {
        heading: "Najčešći pot",
        blocks: [
          "Button otvara na 2,5 bb, big blind calla: pot 5,5 bb, iza 97,5 bb. Ova jedna linija velik je dio postflop ruku svakog online igrača, i u njoj se susreće sve iz ovog modula.",
          "SPR je oko 17,7. Da svi čipovi uđu kroz tri streeta jednakim betovima, svaki bet morao bi biti oko 116 % pota. Zato jedan par rijetko igra za stack u single-raised potu: novac ulazi samo kad jedna strana ima vrlo jaku ruku ili druga strana stalno plaća.",
        ],
      },
      {
        heading: "Flop, turn, river",
        blocks: [
          {
            list: [
              "Flop: checkaj cijeli raspon. Protiv malih betova brani se većinom parova i svakim pravim drawom; raiseaj najjače ruke i najbolje drawove, više na niskim i povezanim boardovima.",
              "Turn nakon tvog calla: nastavi callati s rukama koje su se popravile ili su zadržale dobre outove; najslabije parove foldaj na velike betove.",
              "Turn nakon što button checka iza: njegov je raspon capped, pa probaj s valueom i s drawovima.",
              "River: hvataj blefove rukama koje pobjeđuju blefove buttona kad je cijena dobra, a foldaj one koje ih ne pobjeđuju.",
            ],
          },
          {
            checkpoint: {
              question: "Big blind protiv buttona, 97,5 bb iza pota od 5,5 bb. Otprilike koji jednak bet na svakom od tri streeta uvodi sve čipove?",
              options: ["Oko 33 % pota", "Oko 75 % pota", "Oko 116 % pota"],
              answer: 2,
              explain:
                "Svaki bet približno veličine pota povećava pot za dvostruki iznos beta. Uz SPR blizu 17,7 trebaju betovi malo veći od pota na svakom streetu, zato single-raised pot rijetko ide u all-in s jednim parom.",
              math: { fn: "geometricBet", args: [5.5, 97.5, 3], value: 1.16, tolerance: 0.005 },
              reveal: { id: "spr", pot: 5.5, stack: 97.5 },
            },
          },
        ],
      },
      {
        heading: "Vježba",
        blocks: [
          "Vježba na flopu dijeli big blinda protiv beta buttona na flopovima iz knjižnice; vježbe na turnu i riveru dolaze iz single-raised potova riješenih na zahtjev.",
          {
            note: {
              tone: "approximate",
              text: "Situacije na flopu dolaze iz Railove knjižnice flopova; situacije na turnu i riveru počivaju na rasponima koje Rail sužava kroz ranije streetove. Tvoje ruke na flopovima koje knjižnica nije riješila čitaju se s najbližeg riješenog flopa.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Checkaj flop, brani se široko protiv malih betova, raiseaj jake ruke i dobre drawove.",
        "Foldaj najslabije parove na velike betove na turnu; zadrži ruke koje su se popravile ili imaju dobre outove.",
        "Probaj turnove nakon što button checka iza.",
        "U single-raised potu jedan par rijetko igra za stack.",
      ],
      breaks: [
        "Protiv buttona koji otvara i c-beta gotovo svaku ruku brani se šire i raiseaj više.",
        "Protiv pasivnog buttona koji beta samo jake ruke foldaj više na velike betove na turnu i riveru.",
      ],
    },
    exercises: {
      "bb-flops": "Pet flopova iz Railove knjižnice, big blind protiv beta buttona: fold, call ili raise.",
      "mixed-turns": "Tri turna iz single-raised potova, riješena na zahtjev.",
      "mixed-rivers": "Tri rivera iz single-raised potova, riješena na zahtjev.",
      "your-hands": "Tvoje ruke kao preflop caller u single-raised potovima, na bilo kojem streetu, najskuplje prve.",
    },
    checks: [
      { fn: "sum", args: [2.5, 2.5, 0.5], value: 5.5 },
      { fn: "spr", args: [97.5, 5.5], value: 17.7 },
      { fn: "geometricBet", args: [5.5, 97.5, 3], value: 1.16, tolerance: 0.005 },
    ],
  },
};

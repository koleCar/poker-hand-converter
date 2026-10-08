import type { LessonBodies } from "./types";

/**
 * F4 — 3-bet i 4-bet potovi, hrvatski (Learn L2), osim podjele raspona u
 * poziciji, koja je M6-L4 (`m6.hr.ts`). Ista struktura kao `f4.en.ts`, isti
 * `checks`.
 */
export const f4Hr: LessonBodies<"spr-and-commitment" | "cbetting-as-the-3bettor" | "playing-3bp-as-the-caller" | "four-bet-pots"> = {
  "spr-and-commitment": {
    sections: [
      {
        heading: "SPR određuje koliko jaka ruka mora biti",
        blocks: [
          "Omjer stacka i pota na flopu je efektivni stack podijeljen s potom. Govori ti koliko je koraka veličine pota preostalo dok sve ne uđe, a time i koliko jaka ruka mora biti da bi rado stigla dotle.",
          {
            list: [
              "Button protiv big blinda u single-raised potu: 97,5 / 5,5, oko 17,7.",
              "Big blind 3-beta button na 10 bb i dobije call: 90 / 20,5, oko 4,4.",
              "4-bet na 22 bb, callan: 78 / 44,5, oko 1,8.",
            ],
          },
          "Na 17,7 jedan par je ruka s kojom kontroliraš pot; na 4,4 dobar top par ili overpair često rado stavlja sve; na 1,8 gotovo svaki par s dobrim kickerom.",
          {
            widget: { id: "spr", pot: 20.5, stack: 90 },
            caption: "3-bet pot. Postavi dva ili tri streeta da vidiš bet koji uvodi stackove, a zatim probaj single-raised pot od 5,5 bb.",
          },
        ],
      },
      {
        heading: "Kako te bet na flopu veže",
        blocks: [
          "U 3-bet potu bet na flopu od trećine pota je oko 6,8 bb. Uz call pot je 20,5 + 6,8 + 6,8 = 34,1 bb, a iza je 83,2 bb: SPR pada na oko 2,4. Još jedan bet veličine pota i all-in pokrivaju ostatak.",
          "Prvi bet je, dakle, odluka o cijeloj ruci. Prije nego što uz nizak SPR betaš ili callaš flop, pitaj se hoćeš li rado uložiti ostatak na većini turnova. Ako nećeš, checkaj ili foldaj sada umjesto da plaćaš dvaput.",
          {
            checkpoint: {
              question: "Nakon tog beta i calla na flopu big blind gura 83,2 bb u 34,1 bb. Koliko equityja treba tvoj call?",
              options: ["Oko 29 %", "Oko 41,5 %", "Oko 50 %"],
              answer: 1,
              explain:
                "Pot nakon all-ina je 34,1 + 83,2 = 117,3 bb, a ti callaš 83,2: 83,2 / (117,3 + 83,2) je oko 41,5 %. Overpair ili jak top par to često ima protiv raspona koji gura.",
              math: { fn: "requiredEquity", args: [117.3, 83.2], value: 0.415 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 117.3, bet: 83.2, share: 0.415 },
            },
          },
        ],
      },
      {
        heading: "Fold nakon što si vezan",
        blocks: [
          "Najskuplja greška uz nizak SPR je uložiti trećinu stacka i onda foldati za ostatak uz dobru cijenu. Rail to označava u tvojim rukama. Ako je ruka vrijedila toliko uložiti, obično vrijedi i posljednji dio; ako nije, greška je bila ranije.",
          "Dublji stackovi rade suprotno: na 200bb isti 3-bet pot ima SPR oko devet, i jedan par opet je ruka koja kontrolira pot.",
          {
            note: {
              tone: "approximate",
              text: "Vježbe na flopu dolaze iz Railove knjižnice flopova, za 6-max i 100bb. Tvoje ruke na flopovima koje nije riješila, ili na drugim dubinama, čitaju se s najbližeg riješenog flopa ili heuristikom.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Izračunaj SPR na flopu prije nego što betaš ili callaš.",
        "Nizak SPR: na flopu odluči hoćeš li igrati za stack.",
        "Uz SPR oko četiri overpairovi i dobri top parovi to obično hoće.",
        "Ne foldaj za mali posljednji bet nakon što si uložio većinu stacka.",
      ],
      breaks: [
        "Protiv raspona koji gura samo nuts čak i ruka koja izgleda vezano može foldati.",
        "Duboki stackovi podižu SPR: jedan par vraća se kontroli pota.",
      ],
    },
    exercises: {
      "spr-drill": "Šest potova i stackova na flopu: izračunaj SPR prije nego što ga kalkulator pokaže.",
      "3bp-commit": "Četiri flopa iz Railove knjižnice u 3-bet potovima, protiv beta: fold, call ili raise.",
      "your-hands": "Tvoje ruke označene zbog folda nakon što si se vezao, ili beta s premalo iza.",
    },
    checks: [
      { fn: "spr", args: [97.5, 5.5], value: 17.7 },
      { fn: "spr", args: [90, 20.5], value: 4.4 },
      { fn: "sum", args: [22, 22, 0.5], value: 44.5 },
      { fn: "sum", args: [100, -22], value: 78 },
      { fn: "spr", args: [78, 44.5], value: 1.8, tolerance: 0.05 },
      { fn: "product", args: [20.5, 0.33], value: 6.8, tolerance: 0.05 },
      { fn: "sum", args: [20.5, 6.8, 6.8], value: 34.1 },
      { fn: "sum", args: [90, -6.8], value: 83.2 },
      { fn: "spr", args: [83.2, 34.1], value: 2.4, tolerance: 0.05 },
      { fn: "sum", args: [34.1, 83.2], value: 117.3 },
      { fn: "spr", args: [190, 20.5], value: 9.3 },
    ],
  },

  "cbetting-as-the-3bettor": {
    sections: [
      {
        heading: "Jači raspon, manji pot do stacka",
        blocks: [
          "Raspon 3-bettora je uzak i jak: veliki parovi, jaki asovi i kraljevi, nekoliko suited blefova. Raspon callera je capped: mnoge svoje najbolje ruke 4-betao bi. Na većini flopova to 3-bettoru daje i [[range-advantage|prednost raspona]] i dobar dio najjačih ruku, uz SPR od oko četiri do šest.",
          "Zato 3-bettor beta često. U Railovim rješenjima to vrijedi i u poziciji i izvan nje, za razliku od single-raised potova, u kojima raiser izvan pozicije checka puno više.",
        ],
      },
      {
        heading: "U poziciji: malo i često",
        blocks: [
          "Kad caller checka 3-bettoru u poziciji, Railova rješenja betaju malo s većinom raspona, na gotovo svakom boardu. Veliki betovi su rijetki. Checkovi su uglavnom srednje ruke, drugi parovi i slabiji top parovi, i rastu na jednobojnim boardovima i boardovima s asom, gdje raspon callera ima više ruku koje mogu uzvratiti.",
        ],
      },
      {
        heading: "Izvan pozicije: i dalje bet, ponekad velik",
        blocks: [
          "Izvan pozicije 3-bettor također beta većinu flopova, najviše na boardovima s kraljem i damom i na uparenima, a najmanje na boardovima s dečkom i niskim boardovima s asom. Mijenja se veličina: overpairovi i top par s najboljim kickerom često betaju veliko, jer uz nizak SPR velik bet na flopu priprema stackove za još dva streeta.",
          {
            widget: { id: "flop-bets", preset: "btn-bb-3bet" },
            caption:
              "Railova knjižnica flopova: big blind 3-beta button i prvi je na potezu. Usporedi njegovo betanje po skupinama boardova s buttonovim single-raised potom.",
          },
          {
            checkpoint: {
              question: "Big blind je 3-betao button i dobio call. Flop Q♠8♦4♣, držiš K♥K♣. Koji plan najbolje odgovara Railovim rješenjima?",
              options: ["Check za zamku", "Bet, često velik", "Samo mali bet"],
              answer: 1,
              explain:
                "Overpair uz SPR oko 4,4 ruka je koja želi stackove u potu. Velik bet na flopu to olakšava kroz još dva streeta i naplaćuje callerove parove i drawove. Railovo rješenje s overpairovima miješa veličine, naginjući velikoj.",
            },
          },
        ],
      },
      {
        heading: "Vježba",
        blocks: [
          "Vježbe dijele 3-bet potove iz knjižnice, u poziciji i izvan nje, a zatim rivere u 3-bet potovima riješene na zahtjev.",
          {
            note: {
              tone: "approximate",
              text: "Situacije na flopu dolaze iz Railove knjižnice flopova, koja pokriva pet linija 3-bet pota za 6-max i 100bb; tvoji 3-bet potovi na drugim linijama, flopovima ili dubinama čitaju se s najbližeg riješenog flopa ili heuristikom.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Kao 3-bettor betaj često: tvoj raspon je jači, a callerov capped.",
        "U poziciji betaj malo s većinom raspona; srednje parove checkaj, više na jednobojnim boardovima i boardovima s asom.",
        "Izvan pozicije i dalje betaj većinu flopova; neka overpairovi i top par s najboljim kickerom betaju veliko.",
        "Uz nizak SPR planiraj stackove od flopa.",
      ],
      breaks: [
        "Protiv callera koji flatcallaju svoje najjače ruke budi oprezniji na niskim i povezanim boardovima.",
        "Protiv callera koji previše foldaju na male betove betaj malo još češće.",
      ],
    },
    exercises: {
      "3bp-flops": "Šest flopova iz Railove knjižnice kao 3-bettor, tvoja prva odluka: check ili bet, i koliko veliko.",
      "3bp-rivers": "Tri rivera kao 3-bettor, riješena na zahtjev.",
      "your-hands": "Tvoje prve odluke na flopu kao 3-bettor, najskuplje prve.",
    },
    checks: [],
  },

  "playing-3bp-as-the-caller": {
    sections: [
      {
        heading: "Što drži tvoj raspon calla",
        blocks: [
          "Kad callaš 3-bet, tvoj je raspon srednji: džepni parovi, suited broadway ruke, suited connectori i nekoliko jakih asova koji nisu htjeli 4-betati. Vrh mu je capped, ali je gust u sredini, i slaže setove, dva para i skale na boardovima koje velike karte 3-bettora promašuju.",
          "Uz SPR od četiri do šest svaki call na flopu velik je dio onoga što je ostalo, pa se brani rukama koje mogu nastaviti.",
        ],
      },
      {
        heading: "Protiv malog c-beta",
        blocks: [
          "U Railovim rješenjima caller protiv malog c-beta u 3-bet potu nastavlja s većinom raspona, a protiv velikog folda puno više. Cijena to objašnjava: trećina pota treba 20 % equityja, tri četvrtine 30 %.",
          {
            list: [
              "Call: parovi, drawovi i overkarte s backdoorom na boardovima koji ti pašu.",
              "Raise: setovi, dva para i jaki drawovi, više na srednjim, povezanim i niskim boardovima, manje na boardovima s asom i jednobojnima.",
              "Fold: ruke bez para i bez drawa na boardovima koji pogoduju 3-bettoru.",
            ],
          },
          {
            checkpoint: {
              question: "Na buttonu si callao 3-bet big blinda. Flop 9♥8♥4♣, on beta trećinu pota. Koja ruka najprirodnije raisea?",
              options: ["A♣Q♦", "7♥6♥", "J♠J♦"],
              answer: 1,
              explain:
                "7♥6♥ ima otvoreni draw na skalu i draw na boju: puno equityja kad dobije call, a raise može odmah uzeti pot. J♠J♦ je overpair koji rado calla i drži blefove u ruci. A♣Q♦ ima dvije overkarte s backdoorom i najviše calla.",
            },
          },
        ],
      },
      {
        heading: "Kad 3-bettor checka, i river",
        blocks: [
          "Kad ti 3-bettor checka u poziciji, betaj malo s najjačim rukama i nešto zraka, a većinu srednjih parova checkaj iza: dobivaju na showdownu i mrze check-raise uz tako malo iza. Ta podjela ima svoju lekciju u ovom modulu.",
          "Na riveru capped linija ide u prilog hvatanju blefova. 3-bettor koji checka jedan street, a kasnije beta veliko, ima manje najboljih ruku nego što se čini; prebroji što može imati prije nego što foldaš dobar par.",
          {
            note: {
              tone: "approximate",
              text: "Situacije na flopu dolaze iz Railove knjižnice flopova, kombinacija po kombinaciju; situacije na riveru rješavaju se na zahtjev iz raspona suženih kroz ranije streetove. Tvoje ruke na drugim flopovima ili linijama čitaju se s najbližeg riješenog flopa ili heuristikom.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Protiv malih c-betova u 3-bet potu nastavi s većinom raspona.",
        "Raiseaj setove, dva para i jake drawove, više na niskim i povezanim boardovima.",
        "Srednje parove checkaj iza kad 3-bettor checka.",
        "Na riveru prebroji value 3-bettora prije nego što foldaš dobar par.",
      ],
      breaks: [
        "Protiv 3-bettora koji betaju samo jake ruke foldaj više slabih parova.",
        "Protiv onih koji betaju svaki street callaj šire do kraja.",
      ],
    },
    exercises: {
      "3bp-defence": "Pet flopova iz Railove knjižnice u 3-bet potovima, protiv beta 3-bettora: fold, call ili raise.",
      "3bp-caller-rivers": "Tri rivera kao caller u 3-bet potovima, riješena na zahtjev.",
      "your-hands": "Tvoje odluke kao caller u 3-bet potovima na flopu, najskuplje prve.",
    },
    checks: [
      { fn: "requiredEquity", args: [4, 1], value: 0.2 },
      { fn: "requiredEquity", args: [7, 3], value: 0.3 },
    ],
  },

  "four-bet-pots": {
    sections: [
      {
        heading: "Gotovo bez prostora",
        blocks: [
          "4-bet na 22 bb uz 100bb, callan: pot je 22 + 22 + 0,5 = 44,5 bb, a iza je 78 bb, SPR oko 1,8. Jedan bet od oko pola pota, callan, i ostatak je manji od pota. Flop je posljednji street s pravim izborima.",
          "Oba raspona su uska i jaka: veliki parovi, as-kralj, nekoliko suited asova. Overpairovi i top parovi rijetko se foldaju, a mnogi flopovi igraju se kao all-in ili check.",
          {
            checkpoint: {
              question: "U tom 4-bet potu betaš 15 bb u 44,5 bb i dobiješ call. Koliko je ostalo iza, a koliki je novi pot?",
              options: ["63 bb iza, pot 74,5 bb", "63 bb iza, pot 59,5 bb", "78 bb iza, pot 74,5 bb"],
              answer: 0,
              explain:
                "Uložio si 15 od svojih 78: ostaje 63 bb. Pot raste za oba beta: 44,5 + 15 + 15 = 74,5 bb. SPR je sada ispod jedan, pa je svaki bet na turnu all-in.",
              math: { fn: "sum", args: [44.5, 15, 15], value: 74.5 },
            },
          },
        ],
      },
      {
        heading: "Mali betovi, all-inovi i foldovi",
        blocks: [
          "S tako malo iza mali bet na flopu obavlja posao velikoga: veže jake ruke obaju igrača i turn pretvara u lagan all-in. Rail nema rješenje ovih potova koje bi pokazao, pa uobičajeno razmišljanje shvati kao vodič, a ne mjerenje: 4-bettor često beta malo na boardovima s visokim kartama, a više checka na niskim povezanim boardovima, gdje parovi callera slažu setove i dva para.",
          "Call na 4-bet izvan pozicije skup je: cijelu ruku igraš uz nizak SPR bez inicijative. Zato rasponi koji se suočavaju s 4-betom uglavnom foldaju ili 5-betaju all-in, a callaju samo s rukama koje dobro igraju za stack.",
        ],
      },
      {
        heading: "Što Rail ovdje može, a što ne može ocijeniti",
        blocks: [
          "Preflop dio ocjenjuju Railovi chartovi: vježba ispod dijeli ruke protiv 4-beta. Flop 4-bet pota nije u knjižnici flopova, pa se dio nakon flopa ovdje uči riječima, a Rail tvoje 4-bet potove nakon flopa ocjenjuje heuristikom.",
          {
            note: {
              tone: "conceptual",
              text: "4-bet potovi nisu u Railovoj knjižnici flopova, pa njihove flopove analiza čita heuristikom, bez ocjene solvera. Kviz iz chartova i računi SPR-a ocjenjuju se kao i inače.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Izračunaj SPR: u 4-bet potu na 100bb oko dva ili manje.",
        "Na visokim boardovima betaj malo: dovoljno je da stackovi uđu.",
        "Ruke za all-in odluči na flopu.",
        "Callaj 4-bet samo s rukama koje dobro igraju za stack.",
      ],
      breaks: [
        "Duboki stackovi pretvaraju 4-bet pot natrag u pot s prostorom za igru.",
        "Protiv igrača koji 4-betaju samo najjače parove foldaj više na flopu.",
      ],
    },
    exercises: {
      "vs-4bet": "Osam ruku protiv 4-beta, iz Railovih chartova: fold, call ili 5-bet all-in.",
      "4bp-spr": "Pet potova i stackova iz 4-bet potova: izračunaj SPR.",
      "your-hands": "Tvoji 4-bet potovi nakon flopa, najskuplji prvi.",
    },
    checks: [
      { fn: "sum", args: [22, 22, 0.5], value: 44.5 },
      { fn: "sum", args: [100, -22], value: 78 },
      { fn: "spr", args: [78, 44.5], value: 1.8, tolerance: 0.05 },
      { fn: "sum", args: [78, -15], value: 63 },
    ],
  },
};

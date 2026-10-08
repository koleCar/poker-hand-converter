import type { LessonBodies } from "./types";

/**
 * M3 — preflop, hrvatski. Isti oblik kao m3.en.ts: iste sekcije, blokovi,
 * widgeti, checkpointi i provjere, s brojevima jednakima engleskima (decimalni
 * zarez, razmak prije %).
 */
export const m3Hr: LessonBodies<
  | "positions-and-opening-ranges"
  | "open-sizing"
  | "facing-an-open"
  | "three-betting"
  | "facing-3bets-and-4bets"
  | "blind-play-and-bvb"
  | "squeezes-and-multiway-preflop"
  | "limpers-and-isolation"
> = {
  "positions-and-opening-ranges": {
    sections: [
      {
        heading: "Svako sjedalo ima ime",
        blocks: [
          "Sjedala se zovu po tome gdje sjede u odnosu na button. Za stolom od šest igrača to su UTG (under the gun), HJ (hijack), CO (cutoff), BTN (button), SB (small blind) i BB (big blind). Prvi preflop igra UTG; button igra zadnji na svakoj ulici nakon flopa.",
          "Full ring stol dodaje tri sjedala sprijeda: UTG, UTG+1, UTG+2, LJ (lojack), HJ, CO, BTN, SB i BB. Rail imenuje sjedalo po udaljenosti od buttona, pa zadnjih šest sjedala stola za devet igrača nosi ista imena kao stol za šest.",
          {
            checkpoint: {
              question: "Koje sjedalo za stolom od devet igrača ima iza sebe točno onoliko igrača koliko UTG za stolom od šest?",
              options: ["UTG+1", "LJ", "HJ"],
              answer: 1,
              explain:
                "UTG u 6-maxu iza sebe ima pet igrača: HJ, CO, BTN, SB i BB. Za stolom od devet istih pet ima lojack. Kad tri rana sjedala foldaju, lojack gleda isti stol kao UTG u 6-maxu.",
            },
          },
        ],
      },
      {
        heading: "Igrači iza tebe određuju rizik",
        blocks: [
          "Kad otvoriš, blindove odmah osvajaš samo ako svi koji tek trebaju odigrati foldaju. Svaki dodatni igrač iza tebe još je jedna prilika da netko drži ruku dovoljno dobru za call ili re-raise.",
          "Izmišljeni broj pokazuje koliko se to brzo zbraja. Recimo da svaki igrač iza tebe u bilo kojoj ruci 10 % vremena drži nešto s čime vrijedi nastaviti. Svi foldaju 0,9 × 0,9 × … jednom po igraču: s dvojicom iza tebe to je 81 %, s petoricom oko 59 %, s osmoricom oko 43 %.",
          "Zato ista ruka koju s buttona rado otvaraš iz under the guna može biti fold. Na kartama se ništa nije promijenilo; promijenio se broj ljudi iza tebe koji se mogu probuditi.",
        ],
      },
      {
        heading: "Pozicija nakon flopa",
        blocks: [
          "Drugi razlog je pozicija. Open s cutoffa ili buttona nakon flopa se obično igra u poziciji, jer nakon tebe igraju samo blindovi, a oni na svakoj kasnijoj ulici igraju prvi. Open iz UTG-a često calla igrač koji će na svakoj ulici igrati nakon tebe.",
          "Kad igraš zadnji, vidiš što protivnik radi prije nego što odlučiš, uzimaš besplatne karte i betaš kad pokaže slabost. Najviše od toga dobivaju ruke kojima treba pomoć boarda, poput suited konektora i malih parova. Zato se [[thinking-in-ranges|rasponi za otvaranje]] šire sa svakim sjedalom bliže buttonu.",
        ],
      },
      {
        heading: "Zašto button otvara toliko ruku",
        blocks: [
          "S kasnih sjedala open je dijelom steal: riskiraš open da osvojiš 1,5 bb koji su već u sredini. Open od 2,5 bb je break-even ako svi foldaju 2,5 / (2,5 + 1,5) = 62,5 % vremena, čak i ako nikad ne pobijedi kad je callan.",
          {
            widget: { id: "bet-math", focus: "steal", pot: 1.5, bet: 2.5, share: 0.6 },
            caption: "Postavi blindove i open. Glavni broj pokazuje koliko često svi moraju foldati da bi steal koji nikad ne pobjeđuje kad je callan bio break-even; pomakni postotak foldova preko njega i vidi kako EV mijenja predznak.",
          },
          "U praksi callani steal i dalje ima equity, a s buttona zadržava i poziciju, pa je stvarni break-even niži. Treba proći samo dvojicu igrača, i zato button otvara daleko više ruku od ijednog ranijeg sjedala. Small blind je poseban slučaj: ostao je samo jedan igrač, ali protiv njega je izvan pozicije cijelu ruku.",
          {
            checkpoint: {
              question: "S buttona otvaraš na 2 bb umjesto na 2,5 bb. Koliko često blindovi moraju foldati za steal koji nikad ne pobjeđuje kad je callan?",
              options: ["Oko 50 %", "Oko 57 %", "Oko 67 %"],
              answer: 1,
              explain: "Riskiraš 2 bb da osvojiš 1,5 bb: 2 / (2 + 1,5) ≈ 57,1 %. Manji open treba manje foldova, i to je dio razloga zašto kasna sjedala otvaraju malo.",
              math: { fn: "alpha", args: [1.5, 2], value: 0.571 },
              reveal: { id: "bet-math", focus: "steal", pot: 1.5, bet: 2, share: 0.57 },
            },
          },
        ],
      },
      {
        heading: "6-max i full ring",
        blocks: [
          "Imena sjedala se poklapaju, a poklapa se i logika. Od lojacka nadalje stol za devet igra slično kao stol za šest, jer iza tebe ostaje isti broj igrača. Razlika su tri sjedala sprijeda: UTG, UTG+1 i UTG+2 u full ringu iza sebe imaju šest, sedam i osam igrača, pa otvaraju puno uže od UTG-a u 6-maxu.",
          "Online cash igre su uglavnom za šest igrača; live igre uglavnom za osam do deset. Ako igraš live, rana sjedala su mjesto gdje ti treba najviše discipline. Rail ima chartove za oboje, a drillovi ispod dijele ruke iz njih sjedalo po sjedalo.",
          {
            list: [
              "Prebroji igrače iza sebe prije nego što pogledaš karte.",
              "Prva tri sjedala u full ringu najuža su sjedala u pokeru.",
              "Od lojacka do buttona razmišljaj kao u 6-maxu.",
            ],
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Što je manje igrača iza tebe, to šire otvaraš: svako sjedalo bliže buttonu dodaje ruke.",
        "U full ringu su UTG do UTG+2 uži od UTG-a u 6-maxu; od lojacka nadalje sjedala igraju kao u 6-maxu.",
        "Steal od 2,5 bb u 1,5 bb blindova break-even je uz 62,5 % foldova, prije nego što uračunaš equity koji zadržava kad je callan.",
        "Kao prvi u potu otvori ili foldaj; limp prepusti small blindu, gdje ga chartovi koriste.",
      ],
      breaks: [
        "Blindovi koji puno brane i 3-betaju čine stealove s kasnih sjedala lošijima; blindovi koji previše foldaju čine ih boljima.",
        "Ante, straddle i kratki stackovi mijenjaju cijenu i ruke koje dobro igraju, pa se slika za 100 bb bez antea pomiče.",
      ],
    },
    exercises: {
      "opens-6max":
        "Dvanaest neotvorenih situacija za stolom od šest igrača, iz Railovih chartova za 100 bb, s naglaskom na tijesne ruke. Otvori ili foldaj prije nego što chart pokaže odgovor.",
      "opens-9max":
        "Isti drill za stolom od devet igrača. Primijeti koliko su prva tri sjedala uža od bilo čega u 6-maxu.",
      "paint-a-seat":
        "Oboji raspon za otvaranje jednog sjedala na mreži, pa ga usporedi s Railovim chartom polje po polje. Uskoro.",
    },
    checks: [
      { fn: "allFold", args: [0.9, 2], value: 0.81 },
      { fn: "allFold", args: [0.9, 5], value: 0.59 },
      { fn: "allFold", args: [0.9, 8], value: 0.43 },
      { fn: "alpha", args: [1.5, 2.5], value: 0.625 },
    ],
  },

  "open-sizing": {
    sections: [
      {
        heading: "Tri stvari koje veličina mijenja",
        blocks: [
          "Veličina opena nije samo navika. Ona odjednom postavlja tri broja: koliko često tvoj open mora odmah osvojiti blindove, kakvu cijenu big blind dobiva za call i koliko je velik pot kad dođe flop.",
          "Svaki od njih vuče na svoju stranu, i zato ne postoji jedna ispravna veličina za svaki stol. Postoji jasan kompromis koji možeš izračunati na salveti.",
        ],
      },
      {
        heading: "Tvoja strana: veći open treba više foldova",
        blocks: [
          "Open riskira svoju veličinu da osvoji 1,5 bb blindova. Break-even postotak foldova je open podijeljen s openom plus blindovi:",
          {
            list: [
              "2 bb: 2 / 3,5 ≈ 57,1 %.",
              "2,5 bb: 2,5 / 4 = 62,5 %.",
              "3 bb: 3 / 4,5 ≈ 66,7 %.",
              "4 bb: 4 / 5,5 ≈ 72,7 %.",
            ],
          },
          "Kad open udvostručiš s 2 bb na 4 bb, ono što osvajaš kad foldaju nije duplo veće; i dalje je to 1,5 bb. Raste samo ono što gubiš svaki put kad ti netko uzvrati.",
          {
            widget: { id: "bet-math", focus: "steal", pot: 1.5, bet: 2.5, share: 0.6 },
            caption: "Pomiči veličinu opena i gledaj kako break-even postotak foldova raste. Dodaj ante blindovima i gledaj kako pada.",
          },
        ],
      },
      {
        heading: "Strana big blinda: veći open daje lošiju cijenu",
        blocks: [
          "Kad small blind folda, big blind calla open umanjen za 1 bb koji je već postavio, u pot od opena plus 1,5 bb. Protiv 2 bb calla 1 u 3,5 i treba 1 / 4,5 ≈ 22,2 %. Protiv 2,5 bb calla 1,5 u 4 i treba oko 27,3 %. Protiv 4 bb calla 3 u 5,5 i treba oko 35,3 %.",
          "Dakle, veći open izbaci više slabih ruku blindova. To je argument za njega. Argument protiv je da su ruke koje nastave jače, a ti si više platio da to saznaš.",
          {
            checkpoint: {
              question: "Otvaraš na 3 bb i small blind folda. Koliko equityja treba big blindu za call?",
              options: ["Oko 25 %", "Oko 31 %", "Oko 40 %"],
              answer: 1,
              explain: "Pot je 3 + 0,5 + 1 = 4,5 bb, a call 3 − 1 = 2 bb. Konačni pot je 6,5 bb, od čega su 2 big blindova: 2 / 6,5 ≈ 30,8 %.",
              math: { fn: "requiredEquity", args: [4.5, 2], value: 0.308 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 4.5, bet: 2, share: 0.308 },
            },
          },
        ],
      },
      {
        heading: "„Otvorim 12 bb i nitko ne calla”",
        blocks: [
          "Open od 12 bb mora osvojiti blindove 12 / 13,5 ≈ 88,9 % vremena da bi kao steal bio break-even. Kad svi foldaju, osvajaš 1,5 bb. Kad netko nastavi, drži ruku kojoj odgovara velik pot, a tvoji slabiji openovi su u problemu.",
          "To je problem golemih openova: malo osvajaš kad foldaju, a puno gubiš kad ne foldaju. Ako nitko nikad ne calla, veličina ne radi svoj posao; samo svaku grešku čini skupom.",
          {
            checkpoint: {
              question: "Za stolom gdje većina igrača folda na velike openove, tko calla tvoj open od 12 bb?",
              options: ["Uglavnom ruke koje su ispred tvojeg raspona", "Bilo koje dvije karte, jer je pot velik", "Iste ruke koje callaju open od 2,5 bb"],
              answer: 0,
              explain: "Visoka cijena filtrira callere. Nastavljaju samo ruke dovoljno jake da im se cijena sviđa, pa tvoj raspon za otvaranje svaki put kad je callan igra protiv vrha njihovog.",
            },
          },
        ],
      },
      {
        heading: "Pot s kojim ideš na flop",
        blocks: [
          "Veličina određuje i omjer stacka i pota. Otvoriš 2,5 bb na 100 bb i big blind calla: pot je 2,5 + 2,5 + 0,5 = 5,5 bb uz 97,5 bb iza, SPR oko 17,7. Otvoriš li 4 bb, pot je 8,5 bb uz 96 bb iza, SPR oko 11,3.",
          {
            widget: { id: "spr", pot: 5.5, stack: 97.5 },
            caption: "Promijeni pot i vidi kako veličina opena pomiče SPR i koliko betova veličine pota treba da stackovi uđu.",
          },
          "Niži SPR olakšava igru za stackove s jednim jakim parom. To odgovara rasponu punom visokih karata, i to je jedan od razloga zašto igrači s rasponima jakima na value vole veće openove.",
        ],
      },
      {
        heading: "Online, live i kada mijenjati",
        blocks: [
          "Railovi chartovi na 100 bb otvaraju na 2,5 bb od UTG-a do buttona i na 3 bb iz small blinda, a na 40 bb na 2,2 bb. To su razumne zadane veličine za online igre s rakeom, gdje blindovi uzvraćaju.",
          "Live poolovi callaju puno češće. Protiv igrača koji callaju gotovo svaki open, veća veličina s rasponom nagnutim prema jakim rukama više osvaja kad je callana. Open od 5 bb kao čisti steal treba 5 / 6,5 ≈ 76,9 % foldova, ali protiv igrača koji previše callaju ti ne stealaš; ti im naplaćuješ.",
          {
            list: [
              "Iza limpera dodaj oko 1 bb za svakog limpera. To je izolacijski raise i ima svoju lekciju.",
              "Ante dodaje mrtvi novac: isti open treba manje foldova, pa možeš otvarati manje i šire.",
              "Straddle udvostručuje big blind; svaku veličinu skaliraj s njim. Rail još ne analizira potove sa straddleom.",
            ],
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Veći open treba više foldova i daje big blindu lošiju cijenu: 2,5 bb treba 62,5 % foldova, a big blindu daje oko 27,3 %.",
        "Kad nitko ne calla tvoje openove, veličina je prevelika, a ne savršena.",
        "Veći open snižava SPR, što odgovara rasponima jakima na value.",
        "Live, protiv igrača koji previše callaju, povećaj veličinu uz jači raspon umjesto da široko stealaš.",
      ],
      breaks: [
        "Uz ante ili straddle mijenja se mrtvi novac, pa online zadane veličine više ne pašu kakve jesu.",
        "Protiv blindova koji puno 3-betaju manji open gubi manje svaki put kad je napadnut.",
      ],
    },
    exercises: {
      "steal-price":
        "Šest openova različitih veličina u 1,5 bb blindova. Izračunaj koliko često svi moraju foldati da bi čisti steal bio break-even prije nego što to pokaže kalkulator.",
      "blind-price":
        "Šest openova, small blind folda. Izračunaj koliko equityja treba big blindu za call prije nego što to pokaže kalkulator.",
      "your-hands":
        "Tvoje vlastite odluke u neotvorenim potovima u kojima je analiza našla najskuplje greške. Odluči prije nego što vidiš što si napravio.",
    },
    checks: [
      { fn: "alpha", args: [1.5, 2], value: 0.571 },
      { fn: "alpha", args: [1.5, 2.5], value: 0.625 },
      { fn: "alpha", args: [1.5, 3], value: 0.667 },
      { fn: "alpha", args: [1.5, 4], value: 0.727 },
      { fn: "requiredEquity", args: [3.5, 1], value: 0.222 },
      { fn: "requiredEquity", args: [4, 1.5], value: 0.273 },
      { fn: "requiredEquity", args: [5.5, 3], value: 0.353 },
      { fn: "alpha", args: [1.5, 12], value: 0.889 },
      { fn: "sum", args: [2.5, 2.5, 0.5], value: 5.5 },
      { fn: "spr", args: [97.5, 5.5], value: 17.7 },
      { fn: "sum", args: [4, 4, 0.5], value: 8.5 },
      { fn: "spr", args: [96, 8.5], value: 11.3 },
      { fn: "alpha", args: [1.5, 5], value: 0.769 },
    ],
  },

  "facing-an-open": {
    sections: [
      {
        heading: "Tri odgovora, tri cijene",
        blocks: [
          "Kad netko otvori ispred tebe, možeš foldati, callati ili 3-betati. Fold te ne stoji ništa više. Call drži pot malim i vodi te na flop. 3-bet riskira više, ali može odmah osvojiti pot i daje ti inicijativu.",
          "Kreni od raspona otvarača, a ne od svojih karata. Open iz UTG-a u full ringu uzak je i jak raspon; open s buttona je širok. Ista ruka može biti 3-bet protiv buttona i fold protiv UTG-a.",
        ],
      },
      {
        heading: "Dominirane ruke",
        blocks: [
          "Ruka je dominirana kad otvarač često drži istu visoku kartu s boljim kickerom. KJ protiv ranog opena klasičan je primjer: kad spojiš kralja, možeš biti protiv AK ili KQ, i izgubiti velik pot s drugim najboljim parom.",
          "[[combos-and-card-removal|Uklanjanje karata]] pokazuje zašto je važno koje karte držiš. S A♠J♦ otvaračev AK pada sa 16 kombinacija na 3 × 4 = 12, isto kao i AQ, ali KQ zadržava svih 16. Blokiraš dio ruku koje te dominiraju, ali ne sve.",
          {
            widget: { id: "combos", preset: "broadway", hand: ["As", "Jd"] },
            caption: "Odaberi svoju ruku i vidi koliko je kombinacija svake jake broadway ruke ostalo. Probaj i K♣J♦ i Q♥J♥.",
          },
          "Parovi i suited konektori nemaju taj problem: rade setove, skale i boje, ruke koje velike potove osvajaju umjesto da ih gube.",
          {
            checkpoint: {
              question: "Protiv uskog opena s rane pozicije, kojoj ruci više prijeti dominacija?",
              options: ["K♣J♦", "7♥6♥", "5♠5♦"],
              answer: 0,
              explain:
                "KJ offsuit radi top par koji uski raspon često tuče boljim kickerom. 76 suited i 55 rijetko rade istu ruku kao otvarač; kad pogode, rade nešto drugo i jako.",
            },
          },
        ],
      },
      {
        heading: "U poziciji ili izvan pozicije",
        blocks: [
          "Dvije ideje određuju cijenu svakog calla ovdje. [[pot-odds|Pot odds]]: equity koji call treba jednak je callu podijeljenom s potom nakon tvog calla, uključujući otvaračev raise. [[equity-realisation-and-implied-odds|Realizacija]]: udio tog equityja koji ruka pretvori u dobitak, veći u poziciji i za ruke koje rade jake ruke, manji izvan pozicije.",
          "Call u poziciji, recimo na buttonu protiv opena s cutoffa, najlakši je call u pokeru: igraš zadnji na svakoj ulici i realiziraš više svojeg equityja. Iza tebe za squeeze ostaju samo blindovi.",
          "Call izvan pozicije je lošiji. Small blind je izvan pozicije prema otvaraču, a iza sebe još ima big blind. Protiv opena od 2,5 bb s buttona small blind calla 2 bb u pot od 4 bb, dok bi big blind callao 1,5 bb u isti pot i treba mu samo oko 27,3 %.",
          {
            checkpoint: {
              question: "Button otvara na 2,5 bb. Koliko equityja treba small blindu za call, prije nego što uzmeš u obzir poziciju i big blind iza?",
              options: ["Oko 27 %", "Oko 33 %", "Oko 40 %"],
              answer: 1,
              explain: "Pot je 2,5 + 0,5 + 1 = 4 bb, a call 2,5 − 0,5 = 2 bb: 2 / 6 ≈ 33,3 %. Lošija cijena od one big blinda, izvan pozicije i bez zatvaranja akcije. Zato small blind naginje 3-betu ili foldu.",
              math: { fn: "requiredEquity", args: [4, 2], value: 0.333 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 4, bet: 2, share: 0.333 },
            },
          },
        ],
      },
      {
        heading: "Rake oporezuje flop",
        blocks: [
          "Railovi chartovi pretpostavljaju rake od 5 % s gornjom granicom od 3 bb, koji se uzima samo kad ruka vidi flop. 3-bet koji osvoji pot preflop ne plaća rake; call koji ide na flop uvijek ga plaća.",
          "Mali potovi plaćaju punih 5 %: pot koji završi na 20 bb plaća 1 bb. Granica počinje pomagati tek u potovima većima od 60 bb, jer je 5 % od 60 bb upravo granica od 3 bb. Single-raised potovi rijetko dođu do toga, pa granični callovi u igrama s rakeom gube više nego što chart bez rakea sugerira. To neke callove gura u 3-betove, a neke u foldove.",
        ],
      },
      {
        heading: "Sve zajedno",
        blocks: [
          {
            list: [
              "Sužavaj raspon s kojim nastavljaš što je otvaračevo sjedalo ranije.",
              "Protiv jakih raspona foldaj dominirane offsuit ruke; zadrži parove i suited ruke koje rade jake ruke.",
              "Callaj više u poziciji, osobito na buttonu; iz small blinda radije 3-betaj ili foldaj.",
              "U igrama s rakeom svaki granični call stoji malo više nego što izgleda.",
            ],
          },
          "Koje ruke Railovi chartovi flataju, a koje 3-betaju mijenja se sa svakim parom sjedala. Drill dijeli tijesne odluke; tamo se lekcija primi.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Što je otvaračevo sjedalo ranije, to uže nastavljaš.",
        "Offsuit ruke koje dijele visoku kartu s otvaračevim rasponom prve idu u fold.",
        "Callaj u poziciji; iz small blinda većinom 3-betaj ili foldaj.",
        "Rake pada na ruke koje vide flop, pa kažnjava callove više nego 3-betove.",
      ],
      breaks: [
        "Protiv otvarača koji previše foldaju na 3-bet, više tvojih callova treba postati 3-bet.",
        "Bez rakea, ili s vrlo dubokim stackovima, spekulativni callovi u poziciji dobivaju na vrijednosti.",
      ],
    },
    exercises: {
      "call-3bet-fold":
        "Dvanaest situacija protiv opena, iz Railovih chartova, s naglaskom na tijesne odluke. Foldaj, callaj ili 3-betaj prije nego što chart pokaže odgovor.",
      "your-hands":
        "Tvoje vlastite odluke protiv opena od UTG+1 do buttona, najskuplje prve. Odluči prije nego što vidiš što si napravio.",
    },
    checks: [
      { fn: "product", args: [4, 4], value: 16 },
      { fn: "product", args: [3, 4], value: 12 },
      { fn: "requiredEquity", args: [4, 1.5], value: 0.273 },
      { fn: "product", args: [20, 0.05], value: 1 },
      { fn: "ratio", args: [3, 0.05], value: 60 },
    ],
  },

  "three-betting": {
    sections: [
      {
        heading: "Dva načina na koja 3-bet pobjeđuje",
        blocks: [
          "3-bet pobjeđuje na dva načina: svi foldaju i odmah uzimaš pot, ili si callan i tvoja ruka dobro igra veći pot. Jake ruke 3-betaju uglavnom zbog drugog razloga, blefovi uglavnom zbog prvog.",
          "Railovi chartovi 3-betaju na trostruki open u poziciji i na četverostruki izvan pozicije. Protiv opena od 2,5 bb s cutoffa, 3-bet s buttona ide na 2,5 × 3 = 7,5 bb u pot od 2,5 + 0,5 + 1 = 4 bb.",
          {
            checkpoint: {
              question: "Cutoff otvara na 2,5 bb, a ti s buttona 3-betaš na 7,5 bb s rukom koja nikad ne pobjeđuje kad je callana. Koliko često svi moraju foldati?",
              options: ["Oko 50 %", "Oko 65 %", "Oko 75 %"],
              answer: 1,
              explain: "Riskiraš 7,5 bb da osvojiš 4 bb u sredini: 7,5 / (7,5 + 4) ≈ 65,2 %. Cutoff i oba blinda moraju foldati.",
              math: { fn: "alpha", args: [4, 7.5], value: 0.652 },
              reveal: { id: "bet-math", focus: "alpha", pot: 4, bet: 7.5, share: 0.65 },
            },
          },
        ],
      },
      {
        heading: "Linearan ili polariziran",
        blocks: [
          "Linearan raspon za 3-bet gradi se odozgo prema dolje: najbolje ruke, pa sljedeće najbolje, bez ičega slabog umiješanog. Polariziran raspon uzima najjače ruke i nešto blefova, a s rukama između calla.",
          "Koji oblik paše ovisi o tome koliko je call dobar. Kad je call privlačan, kao u poziciji protiv kasnog opena, sredina tvojeg raspona može callati i 3-bet postaje polariziran. Kad je call loš, kao iz small blinda s big blindom iza ili gdje rake kažnjava flatove, srednje ruke sele u 3-bet i raspon postaje linearniji.",
          "Protiv otvarača koji prečesto calla 3-betove blefovi gube vrijednost i raspon treba nagnuti linearno. Protiv onoga koji prečesto folda, blefovi dobivaju.",
        ],
      },
      {
        heading: "Izbor blefova: blokeri i igrivost",
        blocks: [
          "Dobri 3-bet blefovi rade dva posla. Uklanjaju dio ruku koje bi te 4-betale i dobro igraju kad su callani. Male suited ase rade oboje: as blokira AA i AK, a ruka radi nuts boje i wheel skale.",
          "Ilustrativni premium raspon ovdje, AA, KK, QQ, AKs i AKo, ima 6 + 6 + 6 + 4 + 12 = 34 kombinacije. Držiš li A♥4♥, smanji se na 3 + 6 + 6 + 3 + 9 = 27: nestalo je 7 od 34, oko 21 %.",
          {
            widget: { id: "combos", preset: "premium", hand: ["Ah", "4h"] },
            caption: "Promijeni ruku i gledaj koliko je premium kombinacija ostalo. Usporedi A♥4♥ sa 7♥6♥, koja ne blokira nijednu.",
          },
          {
            checkpoint: {
              question: "Držiš A♥4♥. Koliko kombinacija AA otvarač može imati?",
              options: ["6", "4", "3"],
              answer: 2,
              explain: "Par ima 6 kombinacija: 4 × 3 / 2. S jednim asom u tvojoj ruci ostaju samo tri asa, a oni se spajaju na 3 × 2 / 2 = 3 načina.",
              math: { fn: "product", args: [3, 2, 0.5], value: 3 },
            },
          },
        ],
      },
      {
        heading: "Veličina 3-beta",
        blocks: [
          "Izvan pozicije povećaj veličinu, na oko četverostruki open: open od 2,5 bb postaje 3-bet od 10 bb. Viša cijena čini callove u poziciji manje privlačnima, a niži SPR olakšava igru izvan pozicije.",
          "Povećaj je opet protiv većih openova. Pravilo je višekratnik opena, a ne fiksni broj: protiv live opena od 5 bb trostruko je 15 bb u poziciji, a četverostruko 20 bb izvan pozicije. 3-bet od 9 bb protiv opena od 5 bb daje otvaraču odličnu cijenu za call.",
          "U poziciji je 3-bet pot već plitak. 3-bet od 7,5 bb koji otvarač calla daje pot od 7,5 + 7,5 + 1,5 = 16,5 bb uz 92,5 bb iza, SPR oko 5,6. Zato se jake ruke s jednim parom u 3-bet potovima često igraju za stackove.",
          {
            checkpoint: {
              question: "Koja je ruka bolji 3-bet blef protiv otvarača koji 4-beta samo jake ruke?",
              options: ["A5 suited", "7♣6♣", "Q♠9♦"],
              answer: 0,
              explain: "A5s blokira AA i AK, pa 4-bet dolazi rjeđe, a kad je callana radi nuts boje i wheel. 76s dobro igra, ali ništa ne blokira. Q9 offsuit malo blokira i loše igra kad je callana.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Trostruki open u poziciji, četverostruki izvan pozicije: uvijek višekratnik opena.",
        "Polariziraj kad je call dobra opcija; idi linearno kad je call loš.",
        "Biraj blefove koji blokiraju raspon za 4-bet i još rade jake ruke: prvo male suited ase.",
        "Protiv callera koji nikad ne foldaju izbaci blefove i 3-betaj za value.",
      ],
      breaks: [
        "Protiv igrača koji previše foldaju na 3-bet gotovo svaka ruka s nešto igrivosti postaje profitabilan 3-bet.",
        "S kratkim stackom 3-bet te može obvezati, pa se blefovi smanjuju, a 3-bet postaje shove ili fold.",
      ],
    },
    exercises: {
      "three-bet-or-not":
        "Dvanaest situacija na buttonu protiv opena, s naglaskom na ruke koje su u Railovim chartovima tijesne. Odluči hoćeš li 3-betati, callati ili foldati.",
      "your-hands":
        "Tvoje vlastite situacije u kojima je najbolja igra po chartu bila 3-bet, najskuplje prve. Odluči prije nego što vidiš što si napravio.",
    },
    checks: [
      { fn: "product", args: [2.5, 3], value: 7.5 },
      { fn: "sum", args: [2.5, 0.5, 1], value: 4 },
      { fn: "sum", args: [6, 6, 6, 4, 12], value: 34 },
      { fn: "sum", args: [3, 6, 6, 3, 9], value: 27 },
      { fn: "ratio", args: [7, 34], value: 0.21 },
      { fn: "product", args: [2.5, 4], value: 10 },
      { fn: "product", args: [5, 3], value: 15 },
      { fn: "product", args: [5, 4], value: 20 },
      { fn: "sum", args: [7.5, 7.5, 1.5], value: 16.5 },
      { fn: "spr", args: [92.5, 16.5], value: 5.6 },
    ],
  },

  "facing-3bets-and-4bets": {
    sections: [
      {
        heading: "Cijena nastavka",
        blocks: [
          "Otvaraš s cutoffa na 2,5 bb, a button 3-beta na 7,5 bb. Pot, zajedno s 3-betom, iznosi 2,5 + 7,5 + 1,5 = 11,5 bb, a call te stoji još 5 bb.",
          {
            checkpoint: {
              question: "Koliko equityja treba za taj call?",
              options: ["Oko 25 %", "Oko 30 %", "Oko 40 %"],
              answer: 1,
              explain: "Konačni pot je 11,5 + 5 = 16,5 bb, a 5 od toga je tvoj call: 5 / 16,5 ≈ 30,3 %. Dobra cijena, ali ruku ćeš igrati izvan pozicije.",
              math: { fn: "requiredEquity", args: [11.5, 5], value: 0.303 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 11.5, bet: 5, share: 0.303 },
            },
          },
          "Sad obrnuto: otvaraš s buttona na 2,5 bb, a big blind 3-beta na 10 bb. Pot je 2,5 + 10 + 0,5 = 13 bb, a call 7,5 bb, pa trebaš 7,5 / 20,5 ≈ 36,6 %. Lošija cijena, ali imaš poziciju. 3-bet izvan pozicije veći je upravo zato da ta zamjena bude poštena.",
        ],
      },
      {
        heading: "Pozicija odlučuje koliko široko nastavljaš",
        blocks: [
          "U poziciji možeš callati 3-betove s više ruku, jer ćeš realizirati njihov equity. Izvan pozicije call sa srednjim rukama je skup: suočavaš se s betovima na svakoj ulici, a protivnika ne vidiš da igra prvi. Tu odgovor naginje 4-betu ili foldu.",
          "Važan je i tvoj raspon za otvaranje. Open s ranog sjedala je jak, pa nastavlja s većim dijelom svojih ruku. Open s buttona je širok, pa većina mora foldati na 3-bet, i to je u redu: ruke koje foldaš otvorio si da osvojiš blindove, a ne da igraš velik pot.",
          "Najviše pate offsuit ruke koje 3-bet raspon dominira, poput KJ ili AT, callane izvan pozicije.",
        ],
      },
      {
        heading: "4-betovi, 5-betovi i kratak SPR",
        blocks: [
          "Railovi chartovi 4-betaju na 2,2 puta 3-bet u poziciji prema 3-betaču i na 2,5 puta izvan pozicije, a na 100 bb 5-bet je all-in. Protiv tog 3-beta big blinda od 10 bb, 4-bet s buttona ide na 10 × 2,2 = 22 bb, a iza ostaje 100 − 22 = 78 bb.",
          "Ako big blind calla, pot je 22 + 22 + 0,5 = 44,5 bb uz 78 bb iza: SPR oko 1,8. Gotovo svaki par ili dobar draw na flopu tada se igra za stackove. Zato je stvarna odluka protiv 4-beta obično fold ili all-in, a callovi ostaju za ruke koje dobro igraju u poziciji.",
          {
            widget: { id: "spr", pot: 44.5, stack: 78 },
            caption: "4-bet pot na 100 bb. Usporedi ga sa SPR-om single-raised pota iz lekcije o veličini opena.",
          },
          {
            checkpoint: {
              question: "Nakon što je 4-bet od 22 bb callan na 100 bb, SPR je oko…",
              options: ["1,8", "6", "13"],
              answer: 0,
              explain: "Svaki igrač ima 78 bb iza, a pot je 22 + 22 + 0,5 = 44,5 bb. 78 / 44,5 ≈ 1,8: manje od dva beta veličine pota.",
              math: { fn: "spr", args: [78, 44.5], value: 1.8 },
            },
          },
        ],
      },
      {
        heading: "Što 4-betač može imati",
        blocks: [
          "Ilustrativni raspon za 4-bet ovdje je KK+, AK, A5s i A4s: 6 + 6 + 16 = 28 value kombinacija i 8 kombinacija blefova. AK u ruci to jako mijenja: AA i KK padaju na po 3 kombinacije, a AK na 3 × 3 = 9, pa se value dio smanjuje s 28 na 15 kombinacija.",
          "Zato su AK i suited asevi omiljene ruke za 5-bet: uklanjaju ruke koje su protiv njih najjače. QQ ne blokira ništa od AA, KK ni AK.",
          {
            widget: { id: "equity", preset: "4bet", hand: ["Qs", "Qh"] },
            caption: "QQ protiv ilustrativnog raspona za 4-bet. Blefovi su velik dio razloga zašto QQ dobro prolazi; zamisli raspon bez njih.",
          },
        ],
      },
      {
        heading: "„Jesam li nit?” — fold na live 4-betove",
        blocks: [
          "U mnogim live igrama 4-bet znači AA ili KK i jako malo drugog. Protiv takvog raspona QQ pobjeđuje samo kad se poboljša, a AK je iza oba para. Fold s njima nije slabost; to je čitanje raspona.",
          {
            checkpoint: {
              question: "Live igrač 4-beta isključivo AA i KK. Držiš A♦K♣. Koliko je kombinacija njegovog raspona ostalo?",
              options: ["12", "9", "6"],
              answer: 2,
              explain: "AA i KK imaju po 6 kombinacija, ukupno 12. Tvoj as ostavlja 3 kombinacije AA, tvoj kralj 3 kombinacije KK: 3 + 3 = 6.",
              math: { fn: "sum", args: [3, 3], value: 6 },
            },
          },
          "Railov drill ocjenjuje prema Railovim chartovima, koji pretpostavljaju protivnika koji 4-beta i s blefovima. Fold s QQ tamo može biti ocijenjen kao greška. Live fold je exploit koji radiš na temelju reada, a drill ti pokazuje od čega odstupaš.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Protiv 3-beta u poziciji callaj više; izvan pozicije naginji 4-betu ili foldu.",
        "Široki otvarači foldaju većinu svojeg raspona na 3-bet; tako i treba biti.",
        "4-bet potovi na 100 bb imaju SPR oko dva: prije flopa odluči jesi li spreman ući sa svime.",
        "Ruke koje blokiraju AA, KK i AK najbolji su 5-betovi i 4-bet blefovi.",
      ],
      breaks: [
        "Protiv igrača koji 4-betaju samo nutse foldaj više jakih ruku nego chart.",
        "S dubokim stackovima callovi dobivaju, a 4-bet blefovi postaju rizičniji, jer 5-bet više nije shove.",
      ],
    },
    exercises: {
      "vs-3bet":
        "Deset situacija protiv 3-beta, iz Railovih chartova, s naglaskom na tijesne ruke. Foldaj, callaj ili 4-betaj.",
      "vs-4bet":
        "Šest situacija protiv 4-beta. Foldaj, callaj ili idi all-in. Zapamti da chart pretpostavlja balansiranog 4-betača.",
    },
    checks: [
      { fn: "sum", args: [2.5, 7.5, 1.5], value: 11.5 },
      { fn: "sum", args: [2.5, 10, 0.5], value: 13 },
      { fn: "requiredEquity", args: [13, 7.5], value: 0.366 },
      { fn: "product", args: [10, 2.2], value: 22 },
      { fn: "sum", args: [100, -22], value: 78 },
      { fn: "sum", args: [22, 22, 0.5], value: 44.5 },
      { fn: "spr", args: [78, 44.5], value: 1.8 },
      { fn: "sum", args: [6, 6, 16], value: 28 },
      { fn: "product", args: [3, 3], value: 9 },
      { fn: "sum", args: [3, 3, 9], value: 15 },
      { fn: "sum", args: [6, 6], value: 12 },
    ],
  },

  "blind-play-and-bvb": {
    sections: [
      {
        heading: "Popust big blinda",
        blocks: [
          "Big blind je već platio 1 bb i preflop igra zadnji. Kad small blind folda, calla open umanjen za taj 1 bb u pot u kojem je već sve. Protiv opena od 2,5 bb to je 1,5 bb u 4 bb: treba mu oko 27,3 %. Protiv 2 bb treba mu oko 22,2 %, protiv 3 bb oko 30,8 %.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 4, bet: 1.5, share: 0.273 },
            caption: "Big blind protiv opena od 2,5 bb. Promijeni pot i call da probaš druge veličine opena.",
          },
          "Nijedno drugo sjedalo ne dobiva takvu cijenu i nitko ne može raiseati iza big blinda. Zato brani više ruku nego što ijedno drugo sjedalo calla.",
        ],
      },
      {
        heading: "Equity treba realizirati",
        blocks: [
          "Cijena nije cijela priča. Big blind svaku ulicu igra izvan pozicije, pa njegove ruke realiziraju manje equityja nego što ga imaju. Ruke koje rade jake ruke, poput suited i povezanih karata, realiziraju više; offsuit ruke sa slabim kickerima manje.",
          "Važno je i otvaračevo sjedalo. Protiv opena s ranog sjedala big blind brani daleko manje ruku nego protiv opena s buttona, čak i uz istu cijenu. Protiv širokih kasnih openova također češće 3-beta, na oko četverostruki open: 10 bb protiv 2,5 bb.",
        ],
      },
      {
        heading: "Small blind: raise ili fold",
        blocks: [
          "Small blind je izvan pozicije prema svima, uključujući big blind koji iza njega tek treba odigrati. Protiv opena dobiva lošiju cijenu od big blinda i ne zatvara akciju, pa većina ruku s kojima nastavlja 3-beta umjesto da calla.",
          {
            checkpoint: {
              question: "Button i big blind dobiju isti open. Zašto small blind calla manje od big blinda?",
              options: [
                "Call ga stoji više, igra izvan pozicije i big blind ga još može squeezati",
                "Karte su mu u prosjeku lošije",
                "Već je izgubio svoj blind",
              ],
              answer: 0,
              explain: "Protiv opena od 2,5 bb small blind calla 2 bb, a big blind 1,5 bb. Small blind je usto nakon flopa izvan pozicije i ima big blind iza sebe. Sve troje govori protiv calla.",
            },
          },
        ],
      },
      {
        heading: "Blind protiv blinda",
        blocks: [
          "Kad svi foldaju do small blinda, ostaje samo big blind. Railovi chartovi ovdje small blindu daju tri opcije: fold, complete za 0,5 bb ili raise na 3 bb. Big blind iza completea može checkati ili raiseati na 4 bb.",
          "Raise riskira još 2,5 bb da osvoji 1,5 bb u sredini, pa kao čisti steal treba 2,5 / 4 = 62,5 % foldova, isto kao open od 2,5 bb s buttona. Complete stoji 0,5 bb u pot od 1,5 bb, uz cijenu od 0,5 / 2 = 25 %, ali big blindu prepušta zadnju riječ i poziciju.",
          {
            checkpoint: {
              question: "Small blind raisea na 3 bb. Koliko equityja treba big blindu za call?",
              options: ["Oko 27 %", "Oko 33 %", "Oko 40 %"],
              answer: 1,
              explain: "Pot je 3 + 1 = 4 bb, a call 2 bb: 2 / 6 ≈ 33,3 %. Lošija cijena nego protiv opena s buttona, ali big blind nakon flopa ima poziciju, a to puno vrijedi.",
              math: { fn: "requiredEquity", args: [4, 2], value: 0.333 },
              reveal: { id: "bet-math", focus: "pot-odds", pot: 4, bet: 2, share: 0.333 },
            },
          },
          "U igri blind protiv blinda oba su raspona široka, pa ruke koje bi protiv ranog opena bile lagani foldovi postaju igrive. Zbog pozicije je big blind nakon flopa ugodnije sjedalo.",
        ],
      },
      {
        heading: "Jednaki blindovi",
        blocks: [
          "Neke live igre igraju s jednakim blindovima: small blind postavlja koliko i big blind. Time nestaje popust small blinda, a za stolom ima više za ukrasti. Uz 1 bb u svakom blindu, open od 2,5 bb s buttona riskira 2,5 da osvoji 2.",
          {
            checkpoint: {
              question: "Oba blinda postavljaju po 1 bb. Koliko često moraju foldati za steal od 2,5 bb s buttona koji nikad ne pobjeđuje kad je callan?",
              options: ["Oko 50 %", "Oko 56 %", "Oko 63 %"],
              answer: 1,
              explain: "U sredini su 2 bb: 2,5 / (2,5 + 2) ≈ 55,6 %. Više mrtvog novca, potrebno manje foldova, pa se stealovi šire.",
              math: { fn: "alpha", args: [2, 2.5], value: 0.556 },
              reveal: { id: "bet-math", focus: "steal", pot: 2, bet: 2.5, share: 0.56 },
            },
          },
          "Small blind sad brani kao drugi big blind: protiv opena od 3 bb calla 2 bb u 5 bb i treba 2 / 7 ≈ 28,6 %. Railovi chartovi napravljeni su za blindove 0,5/1, pa ove igre nema u drillovima; prilagodi se prema cijeni.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Big blind brani široko zbog cijene: oko 27,3 % protiv opena od 2,5 bb.",
        "Brani uže protiv ranih openova nego protiv kasnih, čak i uz istu cijenu.",
        "Iz small blinda, protiv opena, većinom 3-betaj ili foldaj.",
        "U igri blind protiv blinda oba su raspona široka, a big blind ima poziciju.",
        "S jednakim blindovima ima više za ukrasti, a small blind brani kao big blind.",
      ],
      breaks: [
        "Protiv otvarača koji neumorno barrelaju big blind realizira još manje; suzi dno obrane.",
        "Protiv small blinda koji completea pa igra pasivno, big blind može češće raiseati na njegove complete.",
      ],
    },
    exercises: {
      "blind-vs-blind":
        "Deset situacija blind protiv blinda iz Railovih chartova, s naglaskom na tijesne ruke: open, complete ili fold small blinda i odgovori big blinda.",
      "big-blind-defence":
        "Deset situacija u big blindu protiv opena. Foldaj, callaj ili 3-betaj i primijeti kako otvaračevo sjedalo pomiče dno tvojeg raspona.",
    },
    checks: [
      { fn: "requiredEquity", args: [4, 1.5], value: 0.273 },
      { fn: "requiredEquity", args: [3.5, 1], value: 0.222 },
      { fn: "requiredEquity", args: [4.5, 2], value: 0.308 },
      { fn: "product", args: [2.5, 4], value: 10 },
      { fn: "alpha", args: [1.5, 2.5], value: 0.625 },
      { fn: "requiredEquity", args: [1.5, 0.5], value: 0.25 },
      { fn: "requiredEquity", args: [5, 2], value: 0.286 },
    ],
  },

  "squeezes-and-multiway-preflop": {
    sections: [
      {
        heading: "Što je squeeze",
        blocks: [
          "Squeeze je 3-bet nakon opena i barem jednog calla. Dvije stvari ga čine uspješnim. Callerovi čipovi su mrtvi novac koji možeš osvojiti. A callerov raspon je obično ograničen odozgo (capped): s najboljim rukama većina igrača bi sama 3-betala.",
          "I otvarač je u nezgodnoj poziciji: zarobljen između tvojeg raisea i callera koji iza njega još treba odigrati.",
        ],
      },
      {
        heading: "Cijena",
        blocks: [
          "Hijack otvara na 2,5 bb, cutoff calla, a ti si na buttonu. Railovi chartovi squeeze rade kao višekratnik 3-beta plus jedan open za svakog callera: u poziciji trostruko plus jedan, dakle 2,5 × 4 = 10 bb. Pot prije tvoje akcije je 2,5 + 2,5 + 1,5 = 6,5 bb.",
          {
            checkpoint: {
              question: "Koliko često svi moraju foldati da bi taj squeeze od 10 bb bio break-even ako nikad ne pobjeđuje kad je callan?",
              options: ["Oko 55 %", "Oko 61 %", "Oko 70 %"],
              answer: 1,
              explain: "Riskiraš 10 bb da osvojiš 6,5 bb: 10 / 16,5 ≈ 60,6 %. Običan 3-bet od 7,5 bb protiv samog opena od 2,5 bb treba oko 65,2 %. Više mrtvog novca, potrebno manje foldova, iako je squeeze veći.",
              math: { fn: "alpha", args: [6.5, 10], value: 0.606 },
            },
          },
          "Ali sad moraju foldati dvojica, a ne jedan. Ako svaki folda 75 % vremena, obojica foldaju samo oko 56 %: ispod cijene. Ako ograničeni caller folda 85 %, a otvarač 75 %, obojica foldaju oko 64 %, sigurno iznad nje. Squeeze živi od callerove slabosti.",
          {
            widget: { id: "multiway", pot: 6.5, bet: 10, share: 0.75, opponents: 2 },
            caption: "Squeeze protiv dvojice igrača. Promijeni koliko često svaki folda i vidi foldaju li svi dovoljno često.",
          },
        ],
      },
      {
        heading: "Povećaj za svakog callera",
        blocks: [
          "Svaki dodatni caller donosi mrtvi novac i još jednog igrača koji mora foldati, pa squeeze raste. U poziciji s dvojicom callera Railovo pravilo daje pet openova: 2,5 × 5 = 12,5 bb. Izvan pozicije kreće od četverostrukog i dodaje callere na to.",
          {
            checkpoint: {
              question: "Hijack otvara na 2,5 bb, cutoff i button callaju. Po Railovom pravilu, koliki je tvoj squeeze iz small blinda?",
              options: ["10 bb", "12,5 bb", "15 bb"],
              answer: 2,
              explain: "Izvan pozicije osnova su četiri opena, plus jedan za svakog od dvojice callera: 4 + 2 = 6 openova, 2,5 × 6 = 15 bb.",
              math: { fn: "product", args: [2.5, 6], value: 15 },
            },
          },
          "Izvan pozicije želiš ruke koje zadržavaju vrijednost kad su callane: jake ruke i blefove s blokerima i igrivošću, poput suited aseva. Protiv callera koji voli flatati velike ruke squeezaj puno uže.",
        ],
      },
      {
        heading: "Overcall umjesto toga",
        blocks: [
          "Druga opcija je call iza callera. Cijena je dobra: na buttonu iza opena od 2,5 bb i calla plaćaš 2,5 bb u 6,5 bb i trebaš 2,5 / 9 ≈ 27,8 %.",
          "Ali pot u troje mijenja koliko taj equity vrijedi. Čak i s prosječnom rukom tvoj pošteni udio u potu u troje samo je trećina, a equity ti je podijeljen između dvojice protivnika. Top par sa slabim kickerom u multiway potu brzo gubi vrijednost; setovi, skale i boje ne gube.",
          {
            checkpoint: {
              question: "Koja ruka iza opena i calla radije bira overcall nego squeeze?",
              options: ["6♦6♣", "K♠J♦", "A♣2♦"],
              answer: 0,
              explain: "Mali par želi jeftin flop s više igrača u potu, da osvoji velik pot kad napravi set. KJ i A2 offsuit rade top parove koji su u multiway potu često dominirani.",
            },
          },
        ],
      },
      {
        heading: "Kada što",
        blocks: [
          {
            list: [
              "Squeezaj kad je caller ograničen i puno folda, i kad tvoja ruka blokira jake ruke ili dobro igra heads-up.",
              "Overcallaj s parovima i suited rukama koje rade jake ruke, osobito u poziciji.",
              "Foldaj offsuit ruke koje rade samo jedan par; loše prolaze i kao squeeze i kao overcall.",
            ],
          },
          "Railovi chartovi u pot puštaju najviše četiri igrača. Drill iz njih dijeli squeeze situacije, s naglaskom na tijesne odluke.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Squeeze dodaje jedan open za svakog callera na uobičajeni višekratnik 3-beta.",
        "Mrtvi novac snižava potreban postotak foldova, ali moraju foldati dvojica: radi zato što je caller slab.",
        "Overcallaj s parovima i suited rukama; foldaj offsuit ruke koje rade samo jedan par.",
      ],
      breaks: [
        "Protiv callera koji flataju jake ruke squeezaj samo za value.",
        "Protiv otvarača koji rijetko foldaju na 3-bet squeeze gubi fold equity; blefiraj manje.",
      ],
    },
    exercises: {
      "squeeze-spots":
        "Deset situacija iza opena i calla, iz Railovih chartova, s naglaskom na tijesne ruke. Squeezaj, callaj ili foldaj.",
    },
    checks: [
      { fn: "product", args: [2.5, 4], value: 10 },
      { fn: "sum", args: [2.5, 2.5, 1.5], value: 6.5 },
      { fn: "alpha", args: [4, 7.5], value: 0.652 },
      { fn: "allFold", args: [0.75, 2], value: 0.56 },
      { fn: "product", args: [0.75, 0.85], value: 0.64 },
      { fn: "product", args: [2.5, 5], value: 12.5 },
      { fn: "requiredEquity", args: [6.5, 2.5], value: 0.278 },
      { fn: "ratio", args: [1, 3], value: 0.333 },
    ],
  },

  "limpers-and-isolation": {
    sections: [
      {
        heading: "Zašto vrijedi napadati limpere",
        blocks: [
          "Limper je callao big blind umjesto da raisea. Većina igrača jake ruke raisea, pa je raspon za limp obično ograničen odozgo: puno slabih i srednjih ruku, malo velikih. Njegov 1 bb je mrtvi novac.",
          "Izolacijski raise to napada. Cilj mu je odmah osvojiti pot ili igrati heads-up, u poziciji, protiv slabijeg raspona. Ime govori što želi: ostati sam s limperom.",
          {
            note: {
              tone: "approximate",
              text: "Railovi chartovi modeliraju limpera koji može imati bilo koju ruku, kroz mali ugrađeni tremble koji svakoj ruci povremeno dopušta limp. Izolacija se ocjenjuje protiv tog limpera, koji na nju često folda. Rasponi stvarnih limpera razlikuju se od igrača do igrača, a rasponi u river drillu oslanjaju se na Railov vlastiti model sužavanja.",
            },
          },
        ],
      },
      {
        heading: "Koliko velika izolacija",
        blocks: [
          "Railovi chartovi izoliraju na 4 bb preko jednog limpera kad imaš poziciju na njega, dodaju 1 bb za svakog dodatnog limpera i još 1 bb kad si izvan pozicije, kao kad izolira blind. Button preko limpa iz UTG-a ide na 4 bb; preko dvojice limpera na 5 bb; blind preko limpa s buttona na 5 bb; big blind preko trojice limpera na 7 bb.",
          "Buttonovih 4 bb preko jednog limpera riskira 4 bb da osvoji 1 + 1,5 = 2,5 bb, pa kao čisti steal treba 4 / 6,5 ≈ 61,5 % foldova. Preko dvojice limpera, 5 bb u 3,5 bb treba oko 58,8 %, ali sad moraju foldati trojica.",
          {
            checkpoint: {
              question: "Dvojica igrača limpaju, a ti si u big blindu. Kolika je Railova veličina izolacije?",
              options: ["5 bb", "6 bb", "7 bb"],
              answer: 1,
              explain: "4 bb za jednog limpera, 1 bb za drugog limpera i 1 bb jer si izvan pozicije: 4 + 1 + 1 = 6 bb.",
              math: { fn: "sum", args: [4, 1, 1], value: 6 },
            },
          },
          "Live limperi često callaju izolacijske raiseove, a mnogi igrači idu i veće. Kompromis je isti kao kod openova: veći raise te češće dovede u heads-up, ali riskira više kad ne uspije.",
        ],
      },
      {
        heading: "S kojim rukama",
        blocks: [
          "Izoliraj s rukama koje dobro igraju heads-up protiv ograničenog raspona: visoke karte koje rade top par s dobrim kickerom, parovi i suited broadway ruke. Često ćeš biti callan, pa te ruke pobjeđuju kroz value, a ne samo kroz foldove.",
          "Protiv limpera koji calla sve izbaci blefove i izoliraj za value. Protiv onoga koji limpa pa folda na raise, širi. Protiv limpera koji ponekad postavlja zamku s jakim rukama, drži raspon uskim i budi spreman foldati na re-raise.",
        ],
      },
      {
        heading: "Overlimp i big blind",
        blocks: [
          "Overlimp, call od 1 bb iza limpera, jeftin je: plaćaš 1 bb u 2,5 bb i trebaš 1 / 3,5 ≈ 28,6 %. Kvaka je u tome što obično uđe još igrača, a tvoj equity se dijeli među njima. Overlimpaj s rukama koje rade jake ruke, malim parovima i suited konektorima, a ne s offsuit rukama koje rade jedan par.",
          "Big blind u limpanom potu može besplatno checkati ili izolirati. Check zadržava svaku ruku u potu za koji nije platio više; izolacija uzima inicijativu, ali izvan pozicije, i zato je veličina veća.",
          {
            checkpoint: {
              question: "Nakon jednog limpa small blind completea, a big blind checka. Na 100 bb, koliki je SPR na flopu?",
              options: ["Oko 10", "Oko 20", "Oko 33"],
              answer: 2,
              explain: "Tri igrača su stavila po 1 bb, pa je pot 3 bb, a svaki ima 99 bb iza: 99 / 3 = 33. Limpani potovi su duboki, a svaki raspon je širok.",
              math: { fn: "spr", args: [99, 3], value: 33 },
              reveal: { id: "spr", pot: 3, stack: 99 },
            },
          },
        ],
      },
      {
        heading: "Nakon flopa u limpanim potovima",
        blocks: [
          "Svaki raspon u limpanom potu je širok, a stackovi su duboki u odnosu na pot. Veliki blefovi imaju malo za osvojiti; value ruke mogu graditi pot kroz tri ulice.",
          {
            list: [
              "Betaj jake ruke i drawove; slabe checkaj češće nego u raisanim potovima.",
              "Par koji bi bio jak u heads-up raisanom potu u limpanom multiway potu samo je srednja ruka.",
              "U potu koji si izolirao limperov raspon je i dalje ograničen, pa tvoje jake ruke dobivaju isplatu na više ulica.",
            ],
          },
          "River drill te stavlja u limpane potove koje je riješio Railov engine, pa vidiš kako se ti rasponi igraju do kraja.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Izoliraj na 4 bb preko jednog limpera u poziciji, plus 1 bb po dodatnom limperu, plus 1 bb izvan pozicije.",
        "Izoliraj s rukama koje pobjeđuju kroz value protiv ograničenog raspona; protiv calling stationa izbaci blefove.",
        "Overlimpaj s parovima i suited konektorima, a ne s offsuit rukama s jednim parom.",
        "Limpani potovi su duboki: pot gradi s value rukama, a ne velikim blefovima.",
      ],
      breaks: [
        "Protiv limpera koji postavljaju zamke s jakim rukama izoliraj uže i poštuj re-raise.",
        "U live igrama u kojima limperi callaju gotovo svaki raise povećaj veličinu ili izoliraj samo za value.",
      ],
    },
    exercises: {
      "facing-limpers":
        "Deset situacija iza jednog ili više limpera, iz Railovih chartova za limpane potove, s naglaskom na tijesne ruke. Foldaj, overlimpaj ili izoliraj.",
      "limped-rivers":
        "Tri river situacije u limpanim potovima, koje ocjenjuje Railov solver. Odluči prije nego što se pokaže odgovor.",
    },
    checks: [
      { fn: "sum", args: [4, 1, 1, 1], value: 7 },
      { fn: "sum", args: [1, 1.5], value: 2.5 },
      { fn: "alpha", args: [2.5, 4], value: 0.615 },
      { fn: "alpha", args: [3.5, 5], value: 0.588 },
      { fn: "requiredEquity", args: [2.5, 1], value: 0.286 },
    ],
  },
};

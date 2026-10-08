import type { LessonBodies } from "./types";

/**
 * Reference pages since L1.1 (`/learn/reference/<id>`, `REFERENCE_IDS`):
 * L1's M2 — thinking in ranges, out of the course map, kept read-only.
 *
 * M2 — razmišljanje u rasponima, hrvatski. Ista struktura kao `m2.en.ts`, s
 * istim brojevima (decimalni zarez) i istim `checks`; poker riječi ostaju one
 * kojima se služe hrvatski igrači, kao u `content/ranges.hr.ts`.
 */
export const m2Hr: LessonBodies<
  "thinking-in-ranges" | "range-advantage" | "nut-advantage" | "board-texture" | "who-the-next-card-helps" | "range-narrowing"
> = {
  "thinking-in-ranges": {
    sections: [
      {
        heading: "Jedna ruka je nagađanje, raspon je popis",
        blocks: [
          "Kad protivnik beta, primamljivo je pitati što ima. Na to pitanje nema odgovora koji možeš iskoristiti: može držati desetke različitih ruku, a rijetko ćeš saznati koju. Bolje je pitanje koje bi ruke odigrao na ovaj način.",
          "Taj popis ruku je raspon (range). Svaka ruka u njemu ima težinu: neke su uvijek tu, neke samo ponekad. Svaku odluku zapravo donosiš protiv cijelog popisa.",
          {
            checkpoint: {
              question: "Držiš J♥J♦, a igrač koji je cijelu večer igrao tight napravi ti 3-bet. Koje pitanje vodi boljoj odluci?",
              options: [
                "Ima li sada AK ili QQ?",
                "S kojim rukama ovaj igrač radi 3-bet i kako moj JJ stoji protiv svih njih?",
                "Je li djelovao samouvjereno kad je raiseao?",
              ],
              answer: 1,
              explain:
                "Prvo pitanje traži jednu ruku koju nikad nećeš vidjeti, a treće je read koji možeš dodati kasnije. Drugo je ono koje stvarno možeš razraditi: nabroji ruke s kojima radi 3-bet, prebroji ih i usporedi svoj JJ s cijelim popisom.",
            },
          },
        ],
      },
      {
        heading: "Brojanje raspona u kombinacijama",
        blocks: [
          "Rasponi se broje u kombinacijama, pojedinačnim parovima karata. Prije nego što se vidi ijedna karta ima ih 52 × 51 / 2 = 1.326, svrstanih u 169 klasa poput QQ, AKs i AKo.",
          "Klase nisu jednako velike. Offsuit ruka poput AKo ima 4 × 3 = 12 kombinacija: bilo koji od četiri asa s bilo kojim od tri kralja druge boje. Suited ruka ima 4, po jednu za svaku boju. Par ima 6: dvije od četiri dame mogu se izvući na 12 načina ako je redoslijed bitan, a svaka se kombinacija tako broji dvaput, pa 12 / 2 = 6.",
          "Raspon zapisan kao „TT+, AK” stoga ima pet parova po 6 kombinacija, 5 × 6 = 30, plus 16 kombinacija AK: ukupno 46, odnosno 46 / 1.326, oko 3,5 % svih početnih ruku.",
          {
            checkpoint: {
              question: "Koliko ima kombinacija AQ, suited i offsuit zajedno?",
              options: ["4", "12", "16"],
              answer: 2,
              explain:
                "4 suited i 12 offsuit daju 16. Neuparene ruke čine glavninu većine raspona: sam AQ ima više kombinacija nego AA i KK zajedno.",
              math: { fn: "sum", args: [4, 12], value: 16 },
            },
          },
        ],
      },
      {
        heading: "Čitanje tablice",
        blocks: [
          "Rasponi se crtaju u tablici 13 × 13, jedno polje za svaku klasu. Parovi idu dijagonalom od AA u gornjem lijevom kutu do 22 u donjem desnom; suited ruke su iznad dijagonale, a offsuit ruke ispod nje.",
          "Skraćenice to zapisuju u jednom retku. „77+” su sedmice i svaki veći par, „ATs+” je od AT suited do AK suited, a „T9s-76s” su suited connectori od T9 do 76.",
          "Oblik je jednako važan kao veličina. Raspon koji neprekinuto ide od najjačih ruku naniže je linearan. Raspon bez vrha je capped (ograničen odozgo), a raspon bez vrha i bez dna je sažet (condensed), i upravo tako obično izgleda preflop call.",
          {
            widget: { id: "equity", focus: "range", preset: "open-utg", hand: ["Kh", "Qd"] },
            caption:
              "K♥Q♦ protiv ilustrativnog raspona otvaranja s UTG-a, napisanog ručno za učenje. Prebaci raspon na open s buttona i gledaj kako equity iste ruke raste: širi raspon ima puno više ruku koje KQ pobjeđuje.",
          },
        ],
      },
      {
        heading: "Svaka akcija je filtar",
        blocks: [
          "Raspon počinje od pozicije i sužava se sa svakom akcijom. Pozicija radi prvi rez: igrač na UTG-u, kad iza njega još sjedi cijeli stol, otvara daleko manje ruku nego isti igrač na buttonu.",
          {
            list: [
              "Open uklanja ruke preslabe za igru s te pozicije.",
              "Call na raise uklanja većinu najboljih ruku, koje bi napravile reraise, i najslabije, koje bi foldale.",
              "3-bet zadržava najjače ruke i nekoliko pažljivo odabranih blefova.",
              "Svaki bet, call i check nakon flopa ponovno reže; stranica o [[range-narrowing|sužavanju raspona]] to prati street po street.",
            ],
          },
          "Odavde dolazi i „inicijativa”. Preflop raiser i dalje drži najveće parove i najbolje asove; caller ih je većinu ispustio time što nije napravio reraise. Tko može prvi betati na flopu proizlazi iz te razlike, a ne iz pravila o tome tko je raiseao.",
          {
            checkpoint: {
              question: "Igrač na big blindu calla raise umjesto da napravi 3-bet. Koje ruke postaju puno manje vjerojatne?",
              options: ["AA i KK", "Mali suited connectori", "Suited kraljevi poput K9s"],
              answer: 0,
              explain:
                "Većina igrača najveće parove reraisea. Call zadržava sredinu raspona, pa AA i KK naglo padaju, a suited connectori i suited kraljevi ostaju.",
            },
          },
        ],
      },
      {
        heading: "Rasponi protiv igrača koji nisu racionalni",
        blocks: [
          "Česta zamjerka: rasponi pretpostavljaju da protivnici razmišljaju, a mnogi ne razmišljaju. Ali i igrač koji previše calla ima raspon. Širi je i oblikovan navikom, a ne tablicom.",
          "Složi ga iz onoga što vidiš. Igrač koji limpa i calla gotovo sve ima golem, slab raspon sve dok ne raisea; kad takav igrač odjednom raisea river, raspon mu se suzio na jake ruke. Igrač koji nikad ne folda par na jedan bet i na turnu ima svaki par.",
          "Metoda ostaje ista: kreni od ruku koje ta osoba igra, ukloni one koje bi odigrale drukčije i odluči protiv onoga što je ostalo. Mijenja se samo početni popis.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Pitaj koje bi ruke odigrale ovako, a ne koju ruku ima.",
        "Broji u kombinacijama: par ima 6, suited ruka 4, offsuit ruka 12. Jedna neuparena klasa teža je od dva para.",
        "Call uklanja vrh i dno raspona; raise zadržava vrh i nešto blefova.",
        "Protiv neobičnih igrača promijeni početni raspon, a ne metodu.",
      ],
      breaks: [
        "Na početku ruke raspon vrlo loose igrača toliko je širok da ti sužavanje malo govori sve do kasnijih streetova.",
        "Pouzdan tell za jednu odluku može nadjačati raspon, ali neka to bude iznimka, a ne navika.",
      ],
    },
    exercises: {
      "paint-an-open":
        "Uskoro: oboji raspon otvaranja u tablici 13 × 13 napamet i pogledaj koliko se poklapa s Railovom tablicom za 9-max.",
      "full-ring-opens":
        "Dvanaest ruku iz Railovih tablica otvaranja za 9-max 100bb, podijeljenih kako dođu, s različitih pozicija: open ili fold. Za prolaz u sedam ruku od deset odigraj nešto što tablica igra.",
    },
    checks: [
      { fn: "product", args: [52, 51], value: 2652 },
      { fn: "ratio", args: [2652, 2], value: 1326 },
      { fn: "sum", args: [13, 78, 78], value: 169 },
      { fn: "product", args: [4, 3], value: 12 },
      { fn: "ratio", args: [12, 2], value: 6 },
      { fn: "product", args: [5, 6], value: 30 },
      { fn: "sum", args: [30, 16], value: 46 },
      { fn: "ratio", args: [46, 1326], value: 0.035 },
    ],
  },

  "range-advantage": {
    sections: [
      {
        heading: "Dva raspona, jedan board",
        blocks: [
          "Prednost raspona uspoređuje cijele raspone, a ne ruke. Podijeli flop i pitaj: kad bi svaka ruka iz mog raspona odigrala protiv svake iz tvog do rivera, koliko bi često moja pobijedila? Odgovor je equity raspona, prosjek preko svih kombinacija.",
          "To je prvo što čitaš na svakom flopu, jer ti govori tko može betati velik dio svojih ruku, a tko bi uglavnom trebao checkati. O ruci koju držiš još ne govori ništa.",
        ],
      },
      {
        heading: "Zašto je raiser obično ispred",
        blocks: [
          "Uzmi raspone kojima se Rail služi u učenju: open s buttona protiv calla big blinda. Big blind bi s AA, KK, QQ i AK napravio 3-bet, pa nijedna od tih ruku nije u njegovu rasponu calla. To su 6 + 6 + 6 + 16 = 34 kombinacije najjačih početnih ruku koje može imati samo button.",
          "Big blind zadržava više malih parova, suited connectora i slabih suited ruku. Zato boardovi s asom ili kraljem, i suhi boardovi općenito, idu u prilog buttonu. To igrači misle pod „inicijativom”: ne povlasticu zarađenu raiseom, nego oblik koji dva raspona imaju nakon preflop betanja.",
          {
            note: {
              tone: "approximate",
              text: "Rasponi u ovim widgetima napisani su ručno za učenje, nisu Railove izračunate tablice, pa svaki broj shvati kao ilustraciju. Važan je smjer: koji boardovi pogoduju otvaraču, a koji vraćaju callera u igru.",
            },
          },
          {
            checkpoint: {
              question: "Open s buttona protiv calla big blinda, flop A♠8♦3♣. Čiji je raspon ispred?",
              options: ["Buttonov", "Raspon big blinda", "Nijedan: izjednačeno je"],
              answer: 0,
              explain:
                "As je visoka karta koje button ima više, a najbolji asovi big blinda otišli su u njegove 3-betove. Ništa na boardu ne spaja se s malim suited rukama big blinda. Widget pokazuje da je buttonov raspon jasno ispred.",
              reveal: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["As", "8d", "3c"] },
            },
          },
        ],
      },
      {
        heading: "Gdje se razlika smanjuje",
        blocks: [
          "Srednji povezani boardovi mjesto su gdje caller sustiže. Na 8♥7♥6♣ suited connectori i mali parovi big blinda slažu skale, dva para, setove i jake drawove, dok su veliki parovi buttona samo jedan par.",
          {
            checkpoint: {
              question: "S ista dva raspona, koji je od ovih flopova najbliži izjednačenom?",
              options: ["A♦K♣4♥", "Q♣5♦5♥", "8♥7♥6♣"],
              answer: 2,
              explain:
                "Visoke karte i upareni boardovi drže buttona ispred. Srednji povezani board izjednačuje big blinda: widget ga stavlja gotovo točno na pola. Probaj i T♥9♥8♣, gdje je caller čak malo ispred.",
              reveal: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["8h", "7h", "6c"] },
            },
          },
          "Na ovakvim boardovima caller nikad nije daleko iza, a na nekima je i ispred. Zato raiser koji iz navike beta svaki flop gubi novac upravo na ovim teksturama.",
        ],
      },
      {
        heading: "Što ti prednost govori da radiš",
        blocks: [
          "Igrač koji je na boardu ispred može betati često, obično malo. Većina raspona je ispred ili ima dovoljno equityja da ide dalje, a mali bet dovoljan je da najslabije ruke plate ili foldaju.",
          "Igrač koji je iza češće checka i pažljivo brani. Betati prvi u jači raspon rijetko se isplati, jer nastavljaju upravo ruke koje te pobjeđuju.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "utg-vs-bb", board: ["8h", "7h", "6c"] },
            caption:
              "Open s UTG-a protiv big blinda na istom 8♥7♥6♣. Što je raspon otvaranja uži, to ostaje više ispred, čak i na boardovima koji pašu calleru. Prebaci na dvoboj s buttonom za usporedbu.",
          },
          "Prednost raspona određuje koliko često betaš. Koliko veliko betaš ovisi o tome tko ima više najjačih ruku, a to je [[nut-advantage|prednost u nutsu]].",
        ],
      },
      {
        heading: "Što ti ne govori",
        blocks: [
          "To je prosjek. Buttonov raspon koji je ispred na A♠8♦3♣ i dalje ima mnogo ruku koje su promašile, a big blind koji je u prosjeku iza i dalje ima svoje setove. Prednost raspona uokviruje odluku; odluku donosi mjesto tvoje ruke u tvom rasponu.",
          "I pomiče se. Svaka karta na turnu i riveru mijenja ravnotežu, ponekad jako, a stranica o tome [[who-the-next-card-helps|kome pomaže sljedeća karta]] mjeri koliko.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Visoke karte i suhi boardovi pogoduju preflop raiseru; srednji povezani boardovi vraćaju callera.",
        "Što je raspon otvaranja uži, to mu je prednost veća na gotovo svakom flopu.",
        "Prednost raspona govori ti koliko često betati, a ne koliko veliko.",
      ],
      breaks: [
        "Protiv callera koji nikad ne radi 3-bet veliki parovi ostaju u rasponu calla, pa se raiserova prednost na visokim boardovima smanjuje.",
        "U multiway potu svaki dodatni caller dodaje ruke koje pogađaju board, pa raiserova prosječna prednost manje vrijedi.",
      ],
    },
    exercises: {
      "who-is-ahead":
        "Osam flopova, open s buttona protiv calla big blinda s ilustrativnim rasponima. Reci je li button jasno ispred (53,5 % equityja raspona ili više) ili je situacija tijesna (50,5 % ili manje); widget raspon protiv raspona zatim pokazuje podjelu.",
    },
    checks: [{ fn: "sum", args: [6, 6, 6, 16], value: 34 }],
  },

  "nut-advantage": {
    sections: [
      {
        heading: "Vrh raspona",
        blocks: [
          "Prednost raspona uprosječuje sve. Prednost u nutsu gleda samo vrh: od najjačih ruku mogućih na ovom boardu, čiji ih raspon ima više?",
          "Rail je svugdje mjeri na isti način. Nakon flopa ostaje 49 × 48 / 2 = 1.176 kombinacija od dvije karte. Rangiraj ih prema onome što slažu, zadrži najjaču desetinu, njih oko 118, i pitaj koliki udio raspona svakog igrača upada u tu skupinu.",
          {
            note: {
              tone: "approximate",
              text: "Rasponi iza ovih brojeva napisani su ručno za učenje, nisu Railove izračunate tablice. Widgete čitaj zbog smjera: tko ima više vrha i otprilike za koliko.",
            },
          },
        ],
      },
      {
        heading: "U prosjeku ispred, pri vrhu izjednačeno",
        blocks: [
          "Dvije mjere mogu se razilaziti. Open s UTG-a pun je velikih parova i velikih asova, pa je u prosjeku ispred na gotovo svakom flopu. Ali board poput J♠T♠9♠ sastavljen je upravo od karata koje trebaju suited connectori i suited broadway ruke big blinda.",
          {
            checkpoint: {
              question: "Open s UTG-a protiv calla big blinda na J♠T♠9♠. Otvarač je u prosjeku ispred. Je li i njegov udio među najjačim rukama jasno veći?",
              options: ["Da, jasno veći", "Ne, otprilike jednak udjelu callera"],
              answer: 1,
              explain:
                "Equity raspona otvarača je ispred, ali flushevi, skale i setovi raspoređeni su po oba raspona, pa su dva udjela pri vrhu otprilike jednaka. Biti u prosjeku ispred nije isto što i biti ispred pri vrhu.",
              reveal: { id: "range-vs-range", focus: "nuts", preset: "utg-vs-bb", board: ["Js", "Ts", "9s"] },
            },
          },
        ],
      },
      {
        heading: "Prednost u nutsu određuje veličinu",
        blocks: [
          "Prednost raspona govori koliko često betati; prednost u nutsu govori koliko veliko. Veliki bet ili overbet ulaže puno novca, a funkcionira samo ako je dovoljan dio raspona koji beta i dalje ispred kad dobije call. Za to trebaju jake ruke, a priuštiti si to može samo raspon koji ih ima više.",
          {
            list: [
              "Obje prednosti: betaj često, a na raspolaganju su i veliki betovi.",
              "Samo prednost raspona: betaj često, ali malo. Protivnik ima jednako jakih ruku kao ti, a veliki betovi nailaze na njih.",
              "Samo prednost u nutsu: betaj rjeđe, ali veće, s jakim rukama i nešto blefova, a sredinu checkaj.",
              "Nijedna: checkaj puno više i pusti protivnika da beta.",
            ],
          },
          {
            widget: { id: "range-vs-range", focus: "nuts", preset: "utg-vs-bb", board: ["As", "8d", "3c"] },
            caption:
              "Open s UTG-a protiv big blinda na A♠8♦3♣: usporedi dva udjela među najjačih 10 %. Ovdje otvarač ima obje prednosti, školski primjer za veće betove. Promijeni board i gledaj kako se razlika pri vrhu zatvara.",
          },
        ],
      },
      {
        heading: "Gdje caller sustiže pri vrhu",
        blocks: [
          "Niski povezani boardovi najslabije su mjesto otvarača. Big blind brani male parove i suited connectore; veliki parovi otvarača postaju jedan par na boardu punom skala i dva para.",
          {
            checkpoint: {
              question: "Isti dvoboj na 6♠5♦4♣. Je li prednost otvarača među najjačih 10 % velika (14 postotnih bodova ili više) ili mala (8,5 bodova ili manje)?",
              options: ["Velika", "Mala"],
              answer: 1,
              explain:
                "Otvarač je i dalje u prosjeku ispred, ali mu se prednost pri vrhu smanjuje na jednoznamenkastu: big blind drži skale s 8-7, više malih setova i dva para. Veliki betovi otvarača naišli bi upravo na te ruke.",
              reveal: { id: "range-vs-range", focus: "nuts", preset: "utg-vs-bb", board: ["6s", "5d", "4c"] },
            },
          },
        ],
      },
      {
        heading: "Kako to čitati za stolom",
        blocks: [
          "Usred ruke nećeš brojati kombinacije. Umjesto toga postavi dva pitanja: koje od najjačih ruku na ovom boardu može imati svaki od nas, s obzirom na to kako smo ovamo stigli? I je li netko od nas te ruke uklonio preflop?",
          "Caller s big blinda rijetko ima AA ili KK, pa na A♠8♦3♣ set asova pripada otvaraču, kao i A-K, najbolji top par. Na 6♠5♦4♣ skale i mali setovi dolaze iz ruku koje je otvarač uglavnom foldao, i zato je vrh podijeljen.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Prednost raspona određuje koliko često betaš; prednost u nutsu koliko veliko.",
        "Veliki betovi trebaju više jakih ruku nego što ih ima protivnik, a ne samo više equityja.",
        "Na niskim povezanim boardovima callerov udio među najjačim rukama sustiže otvarača.",
        "S prednošću raspona, a bez prednosti u nutsu, betaj malo.",
      ],
      breaks: [
        "Protiv protivnika koji velike betove callaju sa svakim parom veliki value betovi rade i bez jasne prednosti u nutsu.",
        "Kasnije u ruci oba su raspona sužena, pa udjeli početnih raspona više ne vrijede.",
      ],
    },
    exercises: {
      "who-has-the-nuts":
        "Osam flopova, open s UTG-a protiv calla big blinda s ilustrativnim rasponima. Odluči je li prednost otvarača među najjačih 10 % ruku velika (14 postotnih bodova ili više) ili mala (8,5 bodova ili manje); widget zatim pokazuje oba udjela.",
    },
    checks: [
      { fn: "product", args: [49, 48], value: 2352 },
      { fn: "ratio", args: [2352, 2], value: 1176 },
      { fn: "product", args: [1176, 0.1], value: 118 },
    ],
  },

  "board-texture": {
    sections: [
      {
        heading: "Četiri riječi za flop",
        blocks: [
          "Prije nego što razmisliš o ijednom rasponu, opiši board. Rail se služi s četiri jednostavna svojstva, istima kojima njegova analiza opisuje tvoje ruke:",
          {
            list: [
              "Boje: rainbow (tri boje), dvobojan (dvije karte iste boje, pa je moguć flush draw) ili jednobojan (sve iste boje, pa je flush već moguć).",
              "Uparenost: uparen ili neuparen.",
              "Povezanost: koliko kombinacija od dvije karte upravo sada slaže skalu. Nijedna znači nepovezan, jedna ili dvije djelomično povezan, tri ili više povezan.",
              "Najviša karta: as, visok (broadway, od T do K), srednji (od 7 do 9) ili nizak (6 i niže).",
            ],
          },
          {
            widget: { id: "board-texture", focus: "texture", board: ["Qh", "Jh", "4c"] },
            caption:
              "Q♥J♥4♣: dvobojan, neuparen, visok, a po Railovu brojanju i nepovezan, jer nikoje dvije karte još ne slažu skalu. Mijenjaj jednu po jednu kartu i gledaj koje se riječi mijenjaju.",
          },
        ],
      },
      {
        heading: "Povezan znači skale sada, ne drawovi",
        blocks: [
          "Povezanost broji skale koje su već složene. Na 9♣8♦5♠ samo je 7-6 slaže, pa je board djelomično povezan. Na 9♣8♦7♠ slažu je tri kombinacije, J-T, T-6 i 6-5, pa je povezan.",
          "Drawovi su drugo pitanje. Board može nemati nijednu složenu skalu, a ipak biti pun otvorenih straight drawova, gutshotova i flush drawova. To mjeri sljedeće svojstvo.",
          {
            checkpoint: {
              question: "Kako Rail klasificira povezanost J♠T♠4♦?",
              options: ["Nepovezan", "Djelomično povezan", "Povezan"],
              answer: 0,
              explain:
                "Za skalu trebaju tri karte s boarda unutar raspona od pet vrijednosti, a 4 je predaleko od J i T. Zato nijedna kombinacija još ne slaže skalu i board je nepovezan, iako je pun drawova.",
              reveal: { id: "board-texture", focus: "texture", board: ["Js", "Ts", "4d"] },
            },
          },
        ],
      },
      {
        heading: "Statičan ili dinamičan",
        blocks: [
          "Dinamičnost pita koliko će sljedeća karta vjerojatno promijeniti. Rail pogleda svaku neviđenu kartu i prebroji one koje bi promijenile board: treću kartu iste boje, kartu koja dodaje dvije ili više novih kombinacija za skalu ili overkartu, koja se broji kao pola. Taj udio je volatilnost boarda.",
          "Ispod 25 % board je statičan, od 45 % naviše dinamičan, a između umjereno dinamičan. Na K♦7♣2♥ išta mijenjaju samo četiri asa, a kao overkarte broje se kao pola: 2 od 49 neviđenih karata, oko 4 %. Statičan.",
          {
            widget: { id: "board-texture", focus: "dynamism", board: ["Js", "Ts", "4d"] },
            caption:
              "J♠T♠4♦ s volatilnošću na prvom mjestu: nepovezan board iz pitanja iznad je dinamičan. Usporedi ga s K♦7♣2♥, pa dodaj kartu na turnu i gledaj kako se broj pomiče.",
          },
          {
            checkpoint: {
              question: "Q♣5♦5♥: statičan, umjereno dinamičan ili dinamičan?",
              options: ["Statičan", "Umjereno dinamičan", "Dinamičan"],
              answer: 0,
              explain:
                "Na turnu ne može doći flush, a par ostavlja premalo vrijednosti za nove skale. Išta mijenjaju samo kraljevi i asovi, a kao overkarte broje se kao pola: 4 od 49 neviđenih karata, oko 8 %. Daleko ispod 25 %, dakle statičan.",
              math: { fn: "ratio", args: [4, 49], value: 0.082 },
              reveal: { id: "board-texture", focus: "dynamism", board: ["Qc", "5d", "5h"] },
            },
          },
        ],
      },
      {
        heading: "Što tekstura radi ruci",
        blocks: [
          {
            list: [
              "Određuje kome board pogoduje: visoki i upareni boardovi naginju preflop raiseru, srednji povezani calleru.",
              "Na statičnim boardovima mali bet obavi većinu posla, jer turn rijetko mijenja tko je ispred.",
              "Na dinamičnim boardovima gotove ruke žele zaštitu, a drawovi trebaju platiti sljedeću kartu, pa betovi rastu, a ruke koje ne mogu betati veliko često checkaju.",
              "Tanki value i kontrola pota vrijede više na statičnim boardovima; pasivna igra s ranjivim rukama skuplja je na dinamičnima.",
            ],
          },
        ],
      },
      {
        heading: "Navika za svaki flop",
        blocks: [
          "Izgovori četiri riječi, pa statičan ili dinamičan, prije nego što ponovno pogledaš svoje karte. Q♥J♥4♣ za par sekundi postaje „dvobojan, neuparen, nepovezan, visok, umjereno dinamičan”.",
          "Zatim pitaj kome board pogoduje, a tek onda gdje je tvoja ruka. Redoslijed je bitan: tekstura prvo oblikuje oba raspona, a tvoja je ruka jedna kombinacija u jednom od njih.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Opiši board prije nego što razmisliš o rasponima: boje, uparenost, povezanost, najviša karta.",
        "Povezanost broji složene skale; volatilnost broji koliko sljedeća karta mijenja stvari.",
        "Statični boardovi traže male betove, tanki value i kontrolu pota; dinamični veće betove ili checkove.",
      ],
      breaks: [
        "Tekstura opisuje karte, a ne čiji raspon pogađaju: i statičan board može pogodovati calleru.",
        "River nema sljedeću kartu, pa ondje dinamičnost prestaje biti bitna i važi samo ono što je složeno.",
      ],
    },
    exercises: {
      "read-the-flop":
        "Dvanaest nasumičnih flopova, po jedno svojstvo: boje, uparenost, povezanost ili najviša karta. Odgovori prije nego što se alat otvori; služi se istim pravilima kao analiza tvojih ruku.",
      "static-or-dynamic":
        "Osam flopova za razvrstati na statične, umjereno dinamične i dinamične. Statičan znači da board mijenja manje od 25 % sljedećih karata; dinamičan znači 45 % ili više.",
    },
    checks: [
      { fn: "product", args: [4, 0.5], value: 2 },
      { fn: "ratio", args: [2, 49], value: 0.041 },
      { fn: "product", args: [8, 0.5], value: 4 },
    ],
  },

  "who-the-next-card-helps": {
    sections: [
      {
        heading: "Svaka karta iznova slaže raspone",
        blocks: [
          "Flop postavlja prednost raspona i prednost u nutsu; turn ih ponovno miješa. Svaka nova karta neke ruke popravi, a neke pokvari, i budući da su dva raspona sastavljena od različitih ruku, većina karata pomaže jednom rasponu više nego drugome.",
          "To se može izmjeriti: pročitaj equity raspona na flopu, dodaj kartu na turnu i pogledaj kamo se pomiče. Karta koja ga pomiče prema tebi dobra je karta za tvoj raspon; ona koja ga pomiče od tebe je loša.",
          {
            note: {
              tone: "approximate",
              text: "Rasponi su ovdje ilustrativni rasponi iz knjižnice pojmova, napisani ručno za učenje, a ne preuzeti iz Railovih izračunatih tablica. Koliko karta pomiče broj približno je; kamo ga pomiče, to je lekcija.",
            },
          },
        ],
      },
      {
        heading: "Jedan flop, tri turna",
        blocks: [
          "Uzmi T♦6♣2♠ uz open s buttona protiv calla big blinda. Flop je tijesan, button je malo ispred. Pročitaj buttonov broj u widgetu, pa redom dodaj svaku kartu na turnu ispod.",
          {
            widget: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Td", "6c", "2s"] },
            caption: "Sam flop. Dodaj A♠, zatim 4♠, pa 9♠ kao turn i usporedi svaki s ovim brojem.",
          },
          {
            list: [
              "A♠: overkarta koje button ima daleko više. Equity buttonova raspona skoči.",
              "4♠: niska karta koja se gotovo ni s čim ne spaja. Broj se jedva pomakne.",
            ],
          },
          {
            checkpoint: {
              question: "Isti flop, a na turnu je 9♠. Kome pomaže?",
              options: ["Buttonu", "Nikome", "Big blindu"],
              answer: 2,
              explain:
                "Devetka se spaja sa srednjim rukama koje big blind brani, poput 8-7, 9-8, 9-7 i T-9: novi parovi, dva para, skale i straight drawovi. Widget pokazuje equity buttonova raspona jasno niže nego na flopu.",
              reveal: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Td", "6c", "2s", "9s"] },
            },
          },
        ],
      },
      {
        heading: "Koje karte pomažu kome",
        blocks: [
          {
            list: [
              "Overkarte na boardu, osobito asovi i kraljevi, obično pomažu preflop raiseru, čiji ih raspon ima više.",
              "Niske i srednje karte koje se spajaju s boardom obično pomažu calleru, koji brani više suited connectora i malih parova.",
              "Karta koja dovršava draw pomaže onom rasponu koji tog drawa ima više.",
              "Niske karte koje se ni s čim ne spajaju uglavnom malo mijenjaju objema stranama.",
            ],
          },
          {
            checkpoint: {
              question: "Flop K♦7♣2♥, open s buttona protiv calla big blinda. Koji turn najviše pomaže buttonu?",
              options: ["A♠", "8♠", "3♠"],
              answer: 0,
              explain:
                "As je karta koje buttonov raspon ima daleko više, pa mu equity raspona najviše raste. Osmica se spaja sa srednjim rukama big blinda, a trica mijenja vrlo malo. Usporedi widget s flopom tako da ukloniš kartu na turnu.",
              reveal: { id: "range-vs-range", focus: "range", preset: "btn-vs-bb", board: ["Kd", "7c", "2h", "As"] },
            },
          },
        ],
      },
      {
        heading: "Barrel, usporiti ili igrati ruku",
        blocks: [
          "Ako si preflop raiser, karta na turnu velik je dio odluke hoćeš li nastaviti betati. Na kartama dobrima za tvoj raspon možeš ponovno betati s više njega; na lošima češće checkaš, a betovi koje ipak napraviš dolaze iz ruku koje i dalje žele novac u potu.",
          "Ako si caller, dobra karta za tvoj raspon trenutak je kad postaju mogući leadovi i raiseovi; loša karta znači da braniš pažljivije.",
          "Ponekad je karta loša za tvoj raspon, ali odlična za tvoju ruku: 9♠ koja šteti buttonovu rasponu daje buttonovoj 8-7 skalu. Protiv jakih igrača misli o rasponu i zadrži nešto jakih ruku među checkovima. Protiv igrača koji previše callaju jednostavno betaj ruku.",
          "River radi na isti način, uz jednu razliku: više ne dolazi nijedna karta. Promašeni drawovi postaju blefovi ili odustaju, a jedino je pitanje tko ima više ruku koje sada pobjeđuju.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Kartu procjenjuj po tome kako pomiče equity raspona, a ne samo po tome što radi tvojoj ruci.",
        "Overkarte, osobito asovi i kraljevi, obično pomažu preflop raiseru.",
        "Niske i srednje karte koje se spajaju s boardom obično pomažu calleru.",
        "Na dobrim kartama betaj veći dio raspona, na lošima uspori.",
      ],
      breaks: [
        "Protiv igrača koji previše callaju karta loša za tvoj raspon, a odlična za tvoju ruku karta je za bet, a ne za balans.",
        "Protiv callera s neobičnim rasponom, primjerice onoga koji brani svaku suited ruku, uobičajene dobre i loše karte se pomiču.",
      ],
    },
    exercises: {
      "whose-card":
        "Osam turnova, svaki na novom flopu, open s buttona protiv calla big blinda s ilustrativnim rasponima. Odluči pomaže li karta buttonu (equity njegova raspona raste za 2 postotna boda ili više), nikome (pomakne se za pola boda ili manje) ili big blindu (padne za 2 boda ili više); widget zatim pokazuje turn.",
    },
    checks: [],
  },

  "range-narrowing": {
    sections: [
      {
        heading: "Kreni široko, reži na svakom streetu",
        blocks: [
          "Raspon nikad nije zadan jednom zauvijek. Počinje s rukama koje igrač donosi s te pozicije i gubi neke sa svakom akcijom. Do rivera igrač koji je otvorio, betao flop i betao turn drži puno kraći popis od onoga s kojim je krenuo.",
          "Sužavanje znači svjesno pratiti taj proces. To je najveći dio onoga što igrači zovu čitanjem ruke, i to je ono što odluke na riveru čini mogućima.",
        ],
      },
      {
        heading: "Tri pitanja za svaku akciju",
        blocks: [
          {
            list: [
              "Koje bi ruke raiseale? One odlaze kad igrač samo calla ili checka.",
              "Koje bi ruke foldale? One odlaze kad igrač calla ili beta.",
              "Koje bi ruke odigrale suprotno? Bet uklanja mnoge ruke koje checkaju; check uklanja mnoge ruke koje betaju.",
            ],
          },
          "Odgovori na njih street po street i raspon se suzi na nešto o čemu možeš razmišljati. Ne trebaju ti točne težine: dovoljno je ruke razvrstati na „gotovo uvijek tu”, „ponekad” i „gotovo nikad”.",
          {
            checkpoint: {
              question: "Protivnik je betao flop, a zatim checkao turn na mirnoj karti. Koje ruke postaju manje vjerojatne?",
              options: ["Njegove najjače ruke, koje obično nastavljaju betati", "Promašeni drawovi i slabi parovi", "Ništa se ne mijenja: jedan check malo znači"],
              answer: 0,
              explain:
                "Jake ruke žele novac u potu i na mirnom turnu obično nastavljaju betati, pa check odmiče težinu od njih. Promašeni drawovi i slabi parovi često odustaju, a poneka jaka ruka checka u zamku, pa jake ruke postaju manje vjerojatne, ali ne i nemoguće.",
            },
          },
        ],
      },
      {
        heading: "Razrađen primjer",
        blocks: [
          "Braniš big blind protiv opena s buttona. Board ide K♦7♣2♥, pa 4♠, pa 9♥. Na flopu checkaš i callaš mali bet, na turnu oba igrača checkaju, a na riveru button beta 5 bb u pot od 10 bb.",
          {
            list: [
              "Preflop: samo si callao, pa je button zadržao cijeli raspon otvaranja.",
              "Flop: mali bet na ovom boardu dolazi iz velikog dijela tog raspona, pa se zasad malo što uklanja.",
              "Turn: button je checkao iza. Većina njegovih jakih kraljeva i setova betala bi ponovno, pa im težina pada; ostaju ruke koje žele jeftin showdown i ruke koje su odustale.",
              "River: bet dolazi iz onoga što je ostalo. Nekoliko jakih ruku koje su postavile zamku ili se popravile na devetki, i ruke koje su na turnu odustale, a sada pokušavaju osvojiti pot.",
            ],
          },
          "Recimo da to ostavlja 9 value kombinacija i 6 blefova, ukupno 15. Za call plaćaš 5 bb da osvojiš pot od 10 + 5 + 5 = 20 bb, pa ti treba 5 / 20 = 25 %.",
          {
            checkpoint: {
              question: "Tvoja ruka pobjeđuje svaki blef i gubi od svake value ruke. Koliko često dobiva protiv tog raspona betova?",
              options: ["25 %", "40 %", "60 %"],
              answer: 1,
              explain:
                "Dobiva protiv 6 blefova od 15 kombinacija: 6 / 15 = 40 %. To je daleko iznad 25 % koje traži cijena, pa je call u plusu, pod uvjetom da je broj blefova pošteno prebrojen.",
              math: { fn: "ratio", args: [6, 15], value: 0.4 },
            },
          },
          {
            widget: { id: "bluff-catcher", pot: 10, bet: 5, share: 0.4 },
            caption: "Bluff-catcher protiv beta od pola pota na riveru, s blefovima koji čine 40 % raspona betova. Pomakni udio blefova naniže i pronađi gdje se call prestaje isplaćivati.",
          },
        ],
      },
      {
        heading: "I Rail sužava raspone",
        blocks: [
          "Railova analiza na isti način provodi oba raspona kroz svaku ruku koju učitaš, street po street, s modelom koje ruke betaju, checkaju, callaju i raiseaju. Trener za river kreće upravo od tih suženih raspona.",
          {
            note: {
              tone: "approximate",
              text: "To sužavanje je heuristički model, a ne solver: rasponi koji stignu do rivera Railova su procjena toga kako igrači nastavljaju na ranijim streetovima, i analiza ih tako i označava. Tijesnu ocjenu shvati kao tijesnu.",
            },
          },
          "Stiže i vježba hoda kroz raspon: pogađat ćeš protivnikov raspon na svakom streetu jedne od svojih ruku i uspoređivati ga s rasponom do kojeg dolazi Rail.",
        ],
      },
      {
        heading: "Kad protivnici nisu racionalni",
        blocks: [
          "Sužavanje se može činiti beznadnim protiv igrača koji rade čudne stvari, a za živim stolom i presporim. Pomažu tri navike:",
          {
            list: [
              "Sužavaj prema igraču, a ne prema tablici: bet ili raise pasivnog igrača na riveru uglavnom je value, što god sadržavao uravnotežen raspon.",
              "Primjećuj capped linije: igrač koji je checkao iza na nekom streetu rijetko ima najbolje ruke, pa su tvoji veliki betovi i tvoji bluff-catchevi lakši.",
              "Posao obavi izvan stola: ponovno prođi svoje odluke na riveru u Railu i sužavaj na miru, pa će ti obrasci u igri dolaziti brzo.",
            ],
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Za svaku akciju pitaj koje bi ruke raiseale, koje bi foldale, a koje bi odigrale suprotno.",
        "Ruke razvrstaj na „gotovo uvijek”, „ponekad” i „gotovo nikad” umjesto da loviš točne težine.",
        "Check nakon beta odmiče težinu od najjačih ruku; ne uklanja ih.",
        "Na kraju prebroji value i blefove, pa usporedi udio blefova s cijenom.",
      ],
      breaks: [
        "Protiv igrača koji nikad ne blefiraju river brojka je uglavnom value, kakva god bila linija: foldaj više nego što cijena sugerira.",
        "Igrači koji često slowplayaju drže jake ruke među checkovima, pa im check sužava raspon manje nego inače.",
      ],
    },
    exercises: {
      "range-walk":
        "Uskoro: ponovno prođi jednu od svojih ruku, pogađaj protivnikov raspon na svakom streetu i usporedi ga s rasponom do kojeg Railova analiza dolazi.",
      "river-calls":
        "Četiri situacije na riveru u poziciji, protiv beta, koje Rail rješava na zahtjev. Suzi raspon igrača koji beta u glavi, pa callaj, foldaj ili raiseaj; ocjenjuje se kao što analiza ocjenjuje pravu ruku.",
      "your-hands":
        "Tvoje vlastite odluke na riveru protiv beta u kojima je analiza označila call koji ne pobjeđuje ništa, od najskuplje naniže. Suzi raspon prije nego što vidiš što si napravio.",
    },
    checks: [
      { fn: "sum", args: [9, 6], value: 15 },
      { fn: "sum", args: [10, 5, 5], value: 20 },
      { fn: "requiredEquity", args: [15, 5], value: 0.25 },
    ],
  },
};

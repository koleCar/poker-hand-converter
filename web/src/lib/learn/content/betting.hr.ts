import type { ConceptTexts } from "./types";

type Betting =
  | "spr"
  | "mdf-alpha"
  | "bet-sizing"
  | "continuation-bet"
  | "check-raise"
  | "donk-bet"
  | "bluff-catching"
  | "thin-value"
  | "multiway-pots";

/**
 * Betting, Croatian. Same shape as betting.en.ts, and every number in an
 * example is the English one, checked in `tests/test/learn.test.ts`. Poker
 * words stay the ones Croatian players use; the reader is addressed with "ti".
 */
export const bettingHr: ConceptTexts<Betting> = {
  spr: {
    summary: "Omjer stacka i pota: koliko je potova još iza, a time i koliko je ruka vezana za pot.",
    definition: [
      "SPR je efektivni stack — manji od dvaju stackova koji su još u ruci — podijeljen s potom. Rail ga mjeri na početku svakog streeta, onako kako ga igrači navode („SPR 4 na flopu”), a ne nakon svakog beta.",
      "Tipične vrijednosti na 100 bb: pot s jednim raiseom ulazi u flop sa SPR-om od otprilike 15 do 18, 3-bet pot s oko 4, a 4-bet pot s oko 1.",
    ],
    why: [
      "SPR ti unaprijed govori koje ruke mogu ići all-in. Uz SPR od 1 do 3 top par obično rado ulaže sav novac; uz SPR 15 jedan par želi držati pot malim, a stackovi pripadaju setovima, skalama i jačim rukama.",
      "Pomaže ti isplanirati ruku: koliki mora biti svaki bet da stackovi uđu do rivera i ostavlja li bet sada dovoljno iza da možeš foldati na raise.",
      "Dvije Railove oznake zapravo su pitanja SPR-a: bet koji iza ostavlja premalo (all-in u svemu osim u imenu) i fold nakon što je veći dio stacka već uložen.",
    ],
    formulas: [
      {
        name: "SPR",
        expression: { frac: ["efektivni stack", "pot"] },
        spoken: "SPR je jednak efektivnom stacku podijeljenom s potom, na početku streeta.",
      },
      {
        name: "Geometrijski bet",
        expression: { frac: [["(1 + 2 × SPR)", { sup: "1/n" }, " − 1"], "2"] },
        spoken: "Geometrijski bet, kao udio pota, jednak je: jedan plus dva puta SPR, na potenciju jedan kroz n, minus jedan, sve podijeljeno s dva.",
        where: [["n", "broj preostalih streetova s betom, uz call svakog beta"]],
      },
    ],
    example: {
      title: "3-bet pot",
      setup: "Cutoff otvara na 2,5 bb, button 3-beta na 10 bb, blindovi foldaju, a cutoff calla. Oba su igrača počela sa 100 bb.",
      steps: [
        "Pot na flopu: 10 + 10 + 0,5 + 1 = 21,5 bb. Svaki igrač ima 90 bb iza.",
        "SPR = 90 / 21,5 ≈ 4,2.",
        "Da stackovi uđu kroz tri streeta s jednakim betovima, svaki bet treba biti oko 55 % pota.",
        "Kroz dva streeta za to trebaju betovi otprilike veličine pota (103 %).",
        "Usporedi s potom s jednim raiseom: 2,5 + 2,5 + 0,5 = 5,5 bb uz 97,5 bb iza, SPR ≈ 17,7 — tri beta od oko 116 % pota.",
      ],
      takeaway: "U 3-bet potu tri obična beta stavljaju top par all-in; u potu s jednim raiseom za to trebaju tri beta veća od pota. Ista ruka, drukčiji plan.",
    },
    mistakes: [
      "Igranje jednog para za cijeli stack uz visok SPR.",
      "Fold top para uz SPR 1 nakon što je trećina stacka već uložena.",
      "Bet koji iza ostavlja tek mrvicu: protivnik može callati znajući da nikad nećeš foldati.",
      "Mjerenje SPR-a nakon beta na istom streetu, zbog čega svaka situacija izgleda vezanije nego što jest.",
    ],
    tryIt: "Postavi pot i stackove, a zatim broj streetova: geometrijski bet je veličina kojom sve uđe do rivera.",
  },

  "mdf-alpha": {
    summary: "MDF je dio tvog raspona koji mora nastaviti protiv beta; alpha je koliko te često taj bet mora natjerati na fold.",
    definition: [
      "Alpha je stopa foldova pri kojoj je na nuli bet koji nikad ne dobiva kad je callan: bet riskira vlastiti iznos da osvoji pot, pa protivnik mora foldati u bet / (pot + bet) slučajeva.",
      "Minimalna frekvencija obrane (MDF) druga je strana istog broja: 1 − alpha = pot / (pot + bet). Ako branitelj folda više od toga, bilo koje dvije karte mogu betati u plusu, pa uravnotežen branitelj nastavlja s barem MDF-om svog raspona — callom ili raiseom.",
    ],
    why: [
      "Daju brojke pitanjima „foldam li previše?” i „koliko često ovaj blef mora proći?”. Bet veličine pota mora proći u pola slučajeva; bet od trećine pota u četvrtini.",
      "Vrijede nakon flopa. Preflop su blindovi uloženi prije ikakve odluke, rasponi se jako razlikuju, a MDF obranu krivo čita kao leak. Rail tvoju obranu uspoređuje s MDF-om samo na postflop streetovima.",
      "MDF je smjernica protiv nepoznatog protivnika, a ne zakon. Protiv nekoga tko rijetko blefira brani manje; protiv nekoga tko blefira previše, više.",
    ],
    formulas: [
      {
        name: "Alpha",
        expression: { frac: ["bet", "pot + bet"] },
        spoken: "Alpha je jednaka betu podijeljenom sa zbrojem pota i beta, gdje je pot iznos prije beta.",
      },
      {
        name: "MDF",
        expression: { frac: ["pot", "pot + bet"] },
        spoken: "Minimalna frekvencija obrane jednaka je potu podijeljenom sa zbrojem pota i beta.",
        where: [["pot", "pot prije beta"]],
      },
    ],
    example: {
      title: "Bet od tri četvrtine pota",
      setup: "Pot je 10 bb, a protivnik beta 7,5 bb.",
      steps: [
        "Alpha: 7,5 / (10 + 7,5) ≈ 42,9 %. Čistom blefu treba da foldaš toliko često.",
        "MDF: 10 / 17,5 ≈ 57,1 %. Od 100 kombinacija s kojima dolaziš nastavi s barem 57.",
        "Za običan call cijena je 7,5 / (17,5 + 7,5) = 30 % equityja.",
      ],
      takeaway: "Tri broja, jedan bet: alpha onoga tko beta, MDF branitelja i cijena za onoga tko calla. Tablica uz matematiku donosi ih za uobičajene veličine.",
    },
    mistakes: [
      "Korištenje MDF-a preflop, gdje normalne foldove pogrešno vidi kao leak.",
      "Obrana do MDF-a na svakom streetu: 57 % tri puta zaredom svodi se na 19 % onoga od čega kreneš — i to može biti ispravno, ali samo ako su betovi uravnoteženi.",
      "Zaboravljanje da se i raiseovi računaju kao obrana.",
      "Obrana do MDF-a protiv protivnika koji nikad ne blefira.",
    ],
    tryIt: "Pomiči veličinu beta i gledaj kako alpha i MDF mijenjaju mjesta: veći betovi trebaju manje foldova po betu, ali od branitelja traže da preda više.",
  },

  "bet-sizing": {
    summary: "Mali bet, veliki bet ili overbet: svaka veličina ima svoj posao, a posao ovisi o boardu i o tome koje ruke betaš.",
    definition: [
      "Mali betovi (otprilike od četvrtine do dvije petine pota) mnogim rukama naplaćuju po malo. Pašu rasponima sa širokom prednošću na boardovima koji se ne mijenjaju puno: većina raspona može betati, a većina protivnikova raspona i dalje može callati.",
      "Veliki betovi (od dvije trećine do punog pota) i overbetovi (veći od pota) pašu polariziranim rasponima — vrlo jakim rukama i blefovima, bez sredine — i iza sebe trebaju prednost u nutsu. Oduzimaju equity na boardovima na kojima se equity još pomiče i najviše naplaćuju rukama koje callaju.",
      "Polariziran raspon beta svoje najbolje ruke i blefove, a srednje ruke checka. Spojen (merged) ili linearan raspon beta odozgo prema dolje, uključujući srednje ruke koje su ispred onoga što calla, obično manjom veličinom.",
    ],
    why: [
      "Veličina određuje tko može callati, koliko equityja oduzimaš i koliko blefova mogu nositi tvoje value ruke. Na riveru, uz savršeno polariziran raspon, bet može sadržavati bet / (pot + 2·bet) blefova, a da bluff-catcher i dalje bude indiferentan.",
      "Biranje veličine samo prema jačini ruke — veliko s jakim rukama, malo sa slabima — pažljivom protivniku točno govori što imaš. Veličinu biraj prema rasponu: odluči čemu bet služi, pa u njega stavi svaku ruku s tom svrhom.",
    ],
    formulas: [
      {
        name: "Udio blefova u polariziranom betu",
        expression: { frac: ["bet", "pot + 2 × bet"] },
        spoken: "Udio blefova u polariziranom betu na riveru jednak je betu podijeljenom sa zbrojem pota i dvostrukog beta.",
      },
      {
        name: "Value po blefu",
        expression: { frac: ["pot + bet", "bet"] },
        spoken: "Broj value kombinacija po jednoj blef kombinaciji jednak je zbroju pota i beta podijeljenom s betom.",
      },
    ],
    example: {
      title: "Tri veličine na riveru u pot od 10 bb",
      setup: "Savršeno polariziran raspon na riveru: nuts i air, ništa između.",
      steps: [
        "Pola pota, 5 bb: blefovi mogu činiti 5 / (10 + 10) = 25 % betova — 3 value ruke po blefu.",
        "Veličina pota, 10 bb: 10 / 30 ≈ 33 % blefova — 2 value ruke po blefu.",
        "Dvostruki pot, 20 bb: 20 / 50 = 40 % blefova — 1,5 value ruke po blefu.",
      ],
      takeaway: "Veći betovi nose više blefova po value ruci, ali trebaju dovoljno nuts ruku da bi se isplatili. S malo nutsa manja veličina ti omogućuje da betaš češće.",
    },
    mistakes: [
      "Veliki betovi s jakim rukama, a mali sa slabima.",
      "Overbet bez prednosti u nutsu.",
      "Mali betovi na dinamičnim boardovima, koji drawove puštaju jeftino.",
      "Veliki betovi sa srednjim rukama u raspone koji nastavljaju samo s jačim rukama.",
    ],
    tryIt: "Postavi pot i bet: kalkulator pokazuje udio blefova i omjer value ruku po blefu za polarizirani bet te veličine.",
  },

  "continuation-bet": {
    summary: "Preflop raiser beta flop — često ispravno, nikad automatski.",
    definition: [
      "Continuation bet (c-bet) je bet na flopu igrača koji je napravio posljednji raise prije flopa i time nastavlja agresiju. Na turnu se obično zove drugi barrel.",
      "Koliko često i koliko velik c-bet raditi proizlazi iz prednosti raspona i prednosti u nutsu: na boardovima koji idu u prilog raiserovu rasponu c-betaj često i malo; na boardovima koji idu u prilog calleru rjeđe, a kad betaš, veće.",
    ],
    why: [
      "Raiserov raspon obično ima više visokih karata i visokih parova, pa ga mnogi flopovi bolje pogađaju — a caller promaši većinu flopova. Jeftin bet tada često osvoji pot ili ga gradi s value rukama.",
      "Pozicija to mijenja. U poziciji raiser može samo checkati i na turnu svejedno igrati zadnji; izvan pozicije check predaje inicijativu, a bet je skuplji kad dođe raise.",
      "S više igrača u potu svaki dodatni igrač smanjuje izglede da c-bet prođe: netko obično nešto ima.",
    ],
    formulas: [
      {
        name: "Stopa foldova koja treba čistom c-bet blefu",
        expression: { frac: ["bet", "pot + bet"] },
        spoken: "Stopa foldova koja treba c-bet blefu jednaka je betu podijeljenom sa zbrojem pota i beta.",
      },
    ],
    example: {
      title: "Mali c-bet, suh flop",
      setup: "Heads-up u potu od 6 bb na K♦7♣2♥, ti si button protiv calla big blinda. Prema ilustrativnim rasponima, buttonov raspon ondje ima oko 53 % equityja.",
      steps: [
        "C-bet od trećine pota, 2 bb, treba foldove u 2 / (6 + 2) = 25 % slučajeva da bi bio u plusu s rukom koja nikad ne dobiva kad je callana.",
        "Big blind većinom svog raspona promaši ovaj flop, pa folda daleko češće od toga.",
        "Na 8♥7♥6♣ isti su rasponi otprilike izjednačeni, a big blind ima jednako mnogo jakih ruku: button c-beta rjeđe, a slabije ruke checka.",
      ],
      takeaway: "O c-betu odlučuje flop, a ne raise prije njega.",
    },
    mistakes: [
      "C-bet na svakom flopu, zbog čega je lako pročitati i tvoje checkove i tvoje betove.",
      "C-bet protiv dva ili tri igrača jednako često kao heads-up.",
      "Jedna veličina na svakom boardu.",
      "Bet na flopu bez plana za turn.",
    ],
    tryIt: "Postavi pot i c-bet: kalkulator pokazuje koliko često mora proći kao čisti blef.",
  },

  "check-raise": {
    summary: "Check, pusti protivnika da beta, pa raise: najjače oružje igrača izvan pozicije.",
    definition: [
      "Check-raise je check s namjerom da raiseaš nakon što protivnik beta. To je uglavnom potez izvan pozicije — najčešće big blind protiv c-beta.",
      "Dobar raspon za check-raise ima jake gotove ruke (setove, dva para), jake drawove koji rado ubacuju još novca (semi-blefove) i nekoliko blefova s nešto equityja. Srednje ruke koje žele doći do showdowna uglavnom radije callaju.",
    ],
    why: [
      "Kažnjava česte male c-betove: raise tjera onoga tko beta da folda dno širokog raspona ili uloži puno više novca.",
      "Izvan pozicije gradi pot s jakim rukama, a drawovima naplaćuje više nego što bi call.",
      "Najbolje radi tamo gdje branitelj ima prednost u nutsu — više vrlo jakih ruku od onoga tko beta.",
    ],
    formulas: [
      {
        name: "Stopa foldova koja treba čistom check-raise blefu",
        expression: { frac: ["raise", "pot + raise"] },
        spoken: "Stopa foldova koja treba check-raise blefu jednaka je čipovima koje raise dodaje, podijeljenima sa zbrojem pota prije raisea i tih čipova.",
        where: [
          ["pot", "pot prije tvog raisea, uključujući protivnikov bet"],
          ["raise", "čipovi koje tvoj raise ubacuje"],
        ],
      },
    ],
    example: {
      title: "Raise na mali c-bet",
      setup: "Pot je 6 bb, protivnik beta 2 bb (pot je sada 8 bb), a ti raiseaš na 7 bb.",
      steps: [
        "Tvoj raise dodaje 7 bb da osvoji 8 bb na sredini.",
        "Kao čisti blef mora proći u 7 / (8 + 7) ≈ 46,7 % slučajeva.",
        "Flush draw treba manje od toga jer može dobiti i kad je callan; ruka bez outova treba svih tih 46,7 %.",
      ],
      takeaway: "Check-raise blefovi trebaju imati equity. Bez njega raise treba foldove gotovo u pola slučajeva, i to protiv raspona koji je bio spreman betati.",
    },
    mistakes: [
      "Check-raise samo s nutsom, pa svaki raise otkriva ruku.",
      "Check-raise sa srednjim rukama koje bi radije callale: raise tjera slabije ruke na fold, a jače ga callaju.",
      "Premali raise, koji onome tko beta daje odličnu cijenu za nastavak.",
      "Zaboravljanje čemu raise služi — value, zaštita ili fold equity — i koje ga ruke callaju.",
    ],
    tryIt: "Mijenjaj pot i raise da vidiš koliko često check-raise blef mora proći.",
  },

  "donk-bet": {
    summary: "Lead u preflop raisera izvan pozicije: obično greška, ponekad baš ono pravo.",
    definition: [
      "Donk bet (ili lead) je bet preflop callera izvan pozicije u preflop raisera, prije nego što raiser dobije priliku za continuation bet.",
      "Ime dolazi od reputacije poteza početnika, i većinom je check bolji. Ali postoje boardovi i karte na turnu na kojima je callerov raspon jači, i tamo je mali lead dio zdrave strategije.",
    ],
    why: [
      "U pravilu raiser ima prednost raspona, pa caller checka i pušta ga da beta. Lead sa slabijim rasponom raiseru samo daje lak raise ili fold.",
      "Kad se board okrene prema calleru — niski povezani flopovi na kojima big blind ima dva para i skale ili karta na turnu koja dovršava callerove drawove — lead oduzima inicijativu rasponu koji više ne može betati toliko.",
    ],
    formulas: [
      {
        name: "Stopa foldova koja treba čistom leadu",
        expression: { frac: ["bet", "pot + bet"] },
        spoken: "Stopa foldova koja treba čistom leadu jednaka je betu podijeljenom sa zbrojem pota i beta.",
      },
    ],
    example: {
      title: "Dva flopa za big blind",
      setup: "Button otvara, a big blind calla. S ilustrativnim rasponima u widgetu:",
      steps: [
        "Na K♦7♣2♥ button ima oko 53 % equityja i više najjačih ruku. Lead uzalud odustaje od checka prema jačem rasponu.",
        "Na 8♥7♥6♣ big blind je u blagoj prednosti, s oko 51 %, i ima otprilike jednako mnogo jakih ruku. Mali lead s dijelom raspona ovdje je razuman.",
      ],
      takeaway: "Leadaj tamo gdje board ide u prilog tvom rasponu — ne zato što ti je ruka srednja pa želiš vidjeti gdje stojiš.",
    },
    mistakes: [
      "Lead sa srednjom rukom „da vidim gdje sam”.",
      "Veliki lead, koji na fold tjera upravo ruke koje pobjeđuješ.",
      "Lead na boardovima koji idu u prilog raiseru.",
      "Potpuno izbjegavanje leada, čak i na turnovima koji jasno idu u prilog tvom rasponu.",
    ],
    tryIt: "Usporedi dva raspona na različitim boardovima: lead pripada tamo gdje je callerov udio veći.",
  },

  "bluff-catching": {
    summary: "Call s rukom koja pobjeđuje samo blefove: cijena govori koliko često protivnik mora blefirati.",
    definition: [
      "Bluff-catcher je ruka koja gubi od svakog value beta i pobjeđuje svaki blef. Na riveru nema outova ni showdown vrijednosti protiv ruku koje betaju za value; dobiva samo kad je bet bio blef.",
      "Odluka o callu tada se svodi na jedno pitanje: ima li raspon koji beta više blefova nego što cijena traži?",
    ],
    why: [
      "Većina teških odluka na riveru svodi se na bluff-catch. Ako foldaš svaki, protivnik može nekažnjeno blefirati; ako callaš svaki, isplaćuješ svaki value bet.",
      "Cijena calla je udio blefova uz koji je call na nuli. Uravnotežen igrač blefira točno toliko često; stvarni protivnici rijetko.",
      "Blockeri određuju koji bluff-catcheri callaju prvi: oni koji blokiraju value ruke, a ne blokiraju blefove.",
    ],
    formulas: [
      {
        name: "Blefovi potrebni za call",
        expression: { frac: ["bet", "pot + 2 × bet"] },
        spoken: "Udio blefova koji treba callu jednak je betu podijeljenom sa zbrojem pota i dvostrukog beta, gdje je pot iznos prije beta.",
      },
      {
        name: "EV calla",
        expression: ["blefovi × (pot + bet) − (1 − blefovi) × bet"],
        spoken: "EV calla jednak je udjelu blefova pomnoženom sa zbrojem pota i beta, minus udio value ruku pomnožen s betom.",
      },
    ],
    example: {
      title: "Bet od tri četvrtine pota na riveru",
      setup: "Pot je 20 bb, a protivnik na riveru beta 15 bb. Imaš čisti bluff-catcher.",
      steps: [
        "Call treba 15 / (20 + 30) = 30 % blefova.",
        "Ako protivnik blefira u 25 % slučajeva: 0,25 × 35 − 0,75 × 15 = −2,5 bb. Fold.",
        "Ako blefira u 40 % slučajeva: 0,40 × 35 − 0,60 × 15 = +5 bb. Call.",
      ],
      takeaway: "Call je procjena protivnikova udjela blefova, a ne tvoje ruke. Tvoja ruka samo odlučuje jesi li uopće bluff-catcher.",
    },
    mistakes: [
      "Call s rukom koja ne pobjeđuje ništa što protivnik može imati — čak ni njegove blefove.",
      "Fold svakog bluff-catchera jer „uvijek ima”.",
      "Biranje bluff-catchera koji blokira protivnikove blefove umjesto njegovih value ruku.",
      "Call zbog toga koliko je već u potu, a ne zbog cijene.",
    ],
    tryIt: "Pomiči protivnikov udio blefova i gledaj kako EV calla prelazi u plus točno na cijeni.",
  },

  "thin-value": {
    summary: "Bet s rukom koja je tek malo ispred onoga što je calla — isplativ češće nego što se čini.",
    definition: [
      "Thin value bet je bet s rukom koja je ispred raspona za call, ali ne puno: drugi par na mirnom riveru, top par sa slabim kickerom protiv igrača koji calla široko.",
      "Na riveru, kad nema raisea kojeg bi se trebalo bojati, pravilo je jednostavno: bet donosi dobit kad je više od polovice ruku koje ga callaju slabije od tvoje.",
    ],
    why: [
      "Kad checkaš ruku koju bi callale slabije ruke, svaki put ostavljaš novac na stolu. Kroz mnogo ruku thin value čini velik dio prednosti pobjedničkog igrača.",
      "Najbolje radi u poziciji, na statičnim boardovima, s veličinom koju slabije ruke još mogu callati.",
      "Njegova se suprotnost u analizi pojavljuje kao oznaka: check s nutsom na riveru, gdje bi bilo koji bet callale slabije ruke.",
    ],
    formulas: [
      {
        name: "Dobit u odnosu na check",
        expression: ["stopa callova × bet × (2 × udio callova koje pobjeđuješ − 1)"],
        spoken: "Ono što bet na riveru donosi u odnosu na check jednako je stopi callova puta bet, puta: dva puta udio callova koje pobjeđuješ, minus jedan.",
      },
    ],
    example: {
      title: "Mali bet na riveru s top parom i slabim kickerom",
      setup: "Pot je 20 bb na riveru. Betaš 7 bb. Protivnik calla u 40 % slučajeva.",
      steps: [
        "Ako pobjeđuješ 60 % ruku koje callaju: 0,4 × 7 × (1,2 − 1) = +0,56 bb po betu, u odnosu na check.",
        "Ako ih pobjeđuješ samo 45 %: 0,4 × 7 × (0,9 − 1) = −0,28 bb. Checkaj.",
        "Veći bet obično mijenja oba broja: callova je manje, a callovi koji dođu jači su.",
      ],
      takeaway: "Pitanje nije „jesam li ispred njegova raspona?”, nego „jesam li ispred dijela koji calla?” — a veličina koju odabereš određuje koji je to dio.",
    },
    mistakes: [
      "Check jakih ruku „za svaki slučaj” i propušten value.",
      "Thin value bet izvan pozicije protiv igrača koji često raisea.",
      "Veličina toliko velika da callaju samo jače ruke.",
      "Thin value bet protiv igrača koji nikad ne calla sa slabijom rukom.",
    ],
    tryIt: "Postavi stopu callova i udio callova koje pobjeđuješ; dobit mijenja predznak točno na polovici.",
  },
  "multiway-pots": {
    summary: "Tri ili više igrača u potu: blef traži da svi foldaju, svaki branitelj smije foldati više, a druge najbolje ruke manje se isplate.",
    definition: [
      "Multiway pot je pot za koji se nakon flopa i dalje bore tri ili više igrača. Većina pokerske teorije, i svaki solver koji Rail pokreće, bavi se s dva igrača; s više njih isti brojevi i dalje vrijede, ali se množe.",
      "Fold equity se množi prema dolje: bet odmah osvaja pot samo kad foldaju svi protivnici, pa ako svaki folda jednako često kao heads-up, zajedno foldaju puno rjeđe. A obrana koju bet traži je podijeljena: svakom branitelju dovoljno je nastaviti s manje od minimalne frekvencije obrane da bi stol u cjelini branio dovoljno (podjela MDF-a).",
    ],
    why: [
      "Blefovi koji su dobri heads-up gube novac protiv dva ili tri igrača. U multiway potu betaj jake ruke i jake drawove, a više slabih ruku pusti.",
      "Mijenja se i value. Jak jedan par ili dva para ranjiviji su — više igrača drži karte koje ih prestižu — pa je slowplay skuplji i treba betati da ih naplatiš. Drawovi prema ruci koja nije nuts gube vrijednost: kad ti dođe boja, veća je vjerojatnost nego heads-up da netko drži jaču (obrnuti implied odds).",
      "Rail ocjenjuje multiway odluke samo ondje gdje je to pošteno: call ili fold na flopu, turnu ili riveru po EV-u protiv suženih raspona (na flopu i turnu puta ono što takva ruka kasnije realizira), označeno kao približno i nikad gore od Greške. Sve ostalo u multiway potu dobiva svoje činjenice i bilješke, i ove ideje iza njih.",
    ],
    formulas: [
      {
        name: "Svi foldaju",
        expression: ["f", { sup: "n" }],
        spoken: "Vjerojatnost da svi protivnici foldaju jednaka je stopi foldanja svakog od njih na potenciju broja protivnika.",
        where: [
          ["f", "koliko često svaki protivnik folda"],
          ["n", "broj protivnika u koje ide bet"],
        ],
      },
      {
        name: "Podjela MDF-a, svaki branitelj",
        expression: ["1 − α", { sup: "1/n" }],
        spoken: "Svaki od n branitelja mora nastaviti jedan minus alfa na potenciju jedan kroz n puta, gdje je alfa bet podijeljen s potom plus bet.",
        where: [
          ["α", "bet / (pot + bet), foldovi koje bet treba"],
          ["n", "igrači koji se brane od njega"],
        ],
      },
    ],
    example: {
      title: "Blef od dvije trećine pota u dva igrača",
      setup: "Pot je 12 bb i betaš 8 bb bez ičega, u dva protivnika. Svaki od njih bi heads-up branio minimum i foldao ostatak.",
      steps: [
        "Bet treba foldove u alfa = 8 / (12 + 8) = 40 % slučajeva.",
        "Heads-up branitelj nastavlja u 12 / 20 = 60 % slučajeva i folda u 40 %: blef je na nuli.",
        "Dva protivnika koji svaki foldaju 40 % zajedno foldaju samo 0,4 × 0,4 = 16 % puta.",
        "Blef sada gubi: 0,16 × 12 − 0,84 × 8 = −4,8 bb.",
        "Podjela MDF-a: da njih dvojica zajedno foldaju najviše 40 %, svakom je dovoljno nastaviti 1 − √0,4 ≈ 37 % puta, a ne 60 %.",
      ],
      takeaway: "Sa svakim dodatnim protivnikom blef treba više foldova nego što ih dobiva, a svaki branitelj smije foldati više nego heads-up — zato u multiway potu blefiraj manje i callaj s jačim rukama.",
    },
    mistakes: [
      "Blefiranje u dva ili tri igrača jednako često kao heads-up.",
      "Call jednako širok kao heads-up jer „netko mora braniti” — obrana je podijeljena.",
      "Slowplay top para ili dva para na boardu koji se mijenja, pa nekoliko igrača drawa besplatno.",
      "Call cijelog stacka s drawom koji nije prema nutsu, kad je sa svakim igračem vjerojatnije da netko ima jači.",
    ],
    tryIt: "Dodaj protivnike i gledaj kako pada vjerojatnost da svi foldaju, i koliko manje svaki mora braniti.",
  },
};

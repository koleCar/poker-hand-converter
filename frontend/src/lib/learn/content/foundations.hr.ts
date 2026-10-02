import type { ConceptTexts } from "./types";

/**
 * Foundations, Croatian. Same shape as foundations.en.ts, with the same
 * numbers; every number in an example is checked in `tests/test/learn.test.ts`.
 * Poker words stay the ones Croatian players use; the reader is addressed with "ti".
 */
export const foundationsHr: ConceptTexts<"pot-odds" | "equity-realisation" | "ev-and-grading" | "gto-vs-exploitative" | "position"> = {
  "pot-odds": {
    summary: "Udio konačnog pota koji call košta — a time i equity koji call treba da bi bio na nuli.",
    definition: [
      "Pot odds uspoređuju koliko call košta s onim što može osvojiti. Kad je pred tobom bet, u potu je već sve što je uloženo prije, plus sam bet; tvoj call dodaje posljednji dio. Cijena calla kao udio tog konačnog pota jest equity koji ti treba da budeš na nuli.",
      "Igrači to izražavaju na dva načina: kao omjer („tri prema jedan”: pot je tri puta veći od calla) ili kao postotak (25 %: call je četvrtina pota koji nastaje s njim). To je isti broj.",
    ],
    why: [
      "Svaki call je oklada da tvoja ruka pobjeđuje dovoljno često. Pot odds pitanje „je li ovo dobar call?” pretvaraju u usporedbu: tvoj equity naspram cijene. Ako tvoja ruka pobjeđuje češće nego što cijena traži, call u prosjeku zarađuje; ako ne, gubi.",
      "Veći betovi traže više. Bet od trećine pota traži 20 % equityja za call, bet veličine pota 33 %, overbet od dva pota 40 %. Znati to napamet najbrža je matematika za stolom.",
      "Pot odds su točni samo kad se nakon calla više ništa ne događa — na riveru ili kod all-ina. Kad dolaze još karte i betovi, novac koji osvojiš kasnije (implied odds) i novac koji kasnije izgubiš ili ga ne možeš osvojiti (reverse implied odds) mijenjaju stvarnu cijenu.",
    ],
    formulas: [
      {
        name: "Potreban equity",
        expression: { frac: ["call", "pot + call"] },
        spoken: "Potreban equity jednak je callu podijeljenom zbrojem pota i calla, pri čemu pot uključuje bet pred kojim si.",
        where: [
          ["pot", "sve što je u sredini, uključujući bet pred kojim si"],
          ["call", "koliko te košta da nastaviš"],
        ],
      },
      {
        name: "EV calla",
        expression: ["equity × (pot + call) − call"],
        spoken: "EV calla jednak je tvojem equityju pomnoženom zbrojem pota i calla, minus call.",
      },
    ],
    example: {
      title: "Flush draw na turnu",
      setup: "Pot na turnu je 12 bb i protivnik beta 6 bb. Imaš flush draw: 9 outova među 46 karata koje ne vidiš.",
      steps: [
        "Pot koji možeš osvojiti je 12 + 6 = 18 bb, a call je 6 bb.",
        "Potreban equity: 6 / (18 + 6) = 6 / 24 = 25 %. Kao omjer, 18 prema 6 je 3 prema 1.",
        "Tvoj equity: 9 / 46 ≈ 19,6 % da pogodiš na riveru.",
        "EV calla: 0,196 × 24 − 6 ≈ −1,3 bb.",
        "Da bi call bio na nuli, na riverima na kojima pogodiš treba u prosjeku osvojiti još oko 6,7 bb.",
      ],
      takeaway: "Samo po cijeni ovo je fold. Call postaje tek ako očekuješ dovoljnu isplatu na riveru kad flush dođe — to znače implied odds.",
    },
    mistakes: [
      "Dijeljenje s potom prije beta. 6 kroz 12 nije 50 %: bet je dio onoga što osvajaš.",
      "Uspoređivanje cijene s equityjem protiv svih ruku koje protivnik može imati, umjesto protiv ruku koje stvarno ovako betaju.",
      "Shvaćanje pot oddsa kao cijelog odgovora dok dolaze još karte. Na flopu betovi na kasnijim streetovima mijenjaju koliko call stvarno košta.",
      "Brojanje outova koji pomažu i protivniku — karta za flush koja upari board može mu dati full house.",
    ],
    tryIt: "Pomiči bet i prati potreban equity: mali bet traži malo, overbet puno. Zatim postavi svoj equity i gledaj kako EV calla prelazi nulu točno na potrebnom equityju.",
  },

  "equity-realisation": {
    summary: "Equity je tvoj udio u potu kad bi se sve karte podijelile odmah; realizacija je koliko ga stvarno pokupiš.",
    definition: [
      "Tvoj equity je udio pobjeda (izjednačenja se broje kao pola) kad bi se preostale karte podijelile bez daljnjeg betanja. Prave ruke ne dolaze do showdowna besplatno: na kasnijim streetovima ima betova, a neki od njih te otjeraju s ruke koja bi pobijedila.",
      "Realizacija equityja je udio tog sirovog equityja koji pretvoriš u udio u potu kad se betanje odigra do kraja. Ruka koja realizira 80 % svojih 40 % equityja u novcu se ponaša kao ruka s 32 %. Realizacija može prijeći i 100 %: ruka u poziciji koja betom, kad protivnik checka, osvaja potove koje bi na showdownu izgubila realizira više od svog equityja.",
    ],
    why: [
      "Zato sirovi equity nije dovoljan za call. Preflop ruka može imati equity koji cijena traži i svejedno gubiti novac, jer će često foldati na flopu prije nego što taj equity unovči.",
      "Realizacija je veća u poziciji, s rukama koje slažu jake ruke (suited, povezane, parovi), s inicijativom u betanju i s kraćim stackovima. Manja je izvan pozicije, s offsuit rukama koje slažu slabe top parove i s dubokim stackovima.",
      "Objašnjava i zašto big blind može braniti široko, ali ne sve: dobiva odličnu cijenu, ali ruku igra izvan pozicije.",
    ],
    formulas: [
      {
        name: "Realizirani equity",
        expression: ["equity × R"],
        spoken: "Realizirani equity jednak je equityju pomnoženom s R, faktorom realizacije.",
        where: [["R", "udio equityja koji ruka pretvara u udio u potu; 1 znači sav"]],
      },
    ],
    example: {
      title: "Dvije ruke s istim equityjem u big blindu",
      setup: "Button otvara na 2,5 bb, a small blind folda. U big blindu call košta 1,5 bb u pot od 4 bb, pa treba 1,5 / 5,5 ≈ 27,3 % equityja. Protiv širokog raspona buttona 7♥6♥ ima oko 39,5 %, a K♦4♣ oko 40,3 %.",
      steps: [
        "Sirovi equity kaže da su obje ruke lagani callovi: oko 40 % naspram potrebnih 27,3 %.",
        "Pretpostavimo, radi ilustracije, da 7♥6♥ realizira 90 % svog equityja: slaže skale, boje i dva para, i može nastaviti betati kad pogodi.",
        "Pretpostavimo da K♦4♣ realizira 65 %: uglavnom slaže jedan par sa slabim kickerom, a izvan pozicije često folda na drugi bet.",
        "Realizirano: 0,395 × 0,9 ≈ 35,5 % za 7♥6♥ i 0,403 × 0,65 ≈ 26,2 % za K♦4♣.",
      ],
      takeaway: "Isti sirovi equity, suprotni odgovori: 7♥6♥ udobno prelazi 27,3 %, a K♦4♣ ostaje malo ispod. Faktori realizacije ovdje su pretpostavke za primjer; pravi dolaze iz rješavanja cijele ruke.",
    },
    mistakes: [
      "Call preflop zato što kalkulator equityja kaže da je ruka „ispred raspona”. Equity na showdownu nije novac u tvojem stacku.",
      "Shvaćanje realizacije kao svojstva same ruke. Ista ruka realizira više u poziciji, s inicijativom ili s manje novca iza.",
      "Zaboravljanje druge strane: ruke koje slabo realiziraju i dalje mogu biti dobri raiseovi, jer raise može odmah osvojiti pot.",
    ],
    tryIt: "Odaberi ruku i raspon da vidiš njezin sirovi equity, zatim pomiči faktor realizacije i prati gdje prelazi cijenu.",
  },

  "ev-and-grading": {
    summary: "Očekivana vrijednost je prosječan ishod odluke; Rail ocjenjuje odluku po tome koliko je EV-a izgubila u odnosu na referentnu strategiju.",
    definition: [
      "Očekivana vrijednost (EV) akcije je ono što ona u prosjeku osvaja ili gubi, preko svih načina na koje se ruka može nastaviti, izraženo u big blindovima. Fold vrijedi 0 od trenutka kad foldaš; svaka druga akcija mjeri se u odnosu na to.",
      "Gubitak EV-a je razlika između najbolje opcije i tvog izbora: max EV − EV tvog izbora. Nula znači da je tvoj izbor jednako dobar kao najbolji; gubitak nikad nije negativan.",
      "Rail ocjenjuje odluku uspoređujući je s referentnom strategijom — preflop chartovima, a kasnije solverom. Referenca svakoj opciji u situaciji daje učestalost (koliko često igra tu opciju s tvojom točnom rukom) i EV. Gdje reference nema, Rail ne ocjenjuje: prikazuje oznake, bilješke o provjerama koje vrijede bez obzira na strategiju, i nikad oznaku ne proglašava gorom od Netočno.",
    ],
    why: [
      "Rezultati kratkoročno lažu. Osvojiti pot lošim callom ne čini call dobrim; EV je način da odluku razlikuješ od sreće.",
      "Rail mjeri gubitak EV-a kao udio pota, a ne u big blindovima, jer je istih 2 bb katastrofa u potu od 4 bb, a šum u potu od 100 bb.",
      "Strategije miješaju. Kad referenca calla u 52 % slučajeva, a raisea u 48 %, obje su opcije ispravne, pa Rail svaku opciju unutar 5 postotnih bodova od najčešće tretira kao Savršeno. Igrač koji uvijek bira opciju od 48 % ni u jednoj pojedinačnoj ruci ne griješi; taj se obrazac vidi u izvještajima, nikad kao ocjena.",
      "Svaki potez dobiva i rezultat od 0 do 100, za prosjeke: 100 minus 1.000 puta gubitak EV-a kao udio pota, pa gubitak od 3 % pota daje 70, a gubitak od 10 % ili više daje 0. Kad je gubitak zanemariv, rezultat je učestalost opcije u odnosu na učestalost najčešće.",
      "Ocjene, redom — Savršeno: unutar 5 bodova od najčešće opcije ili gubitak od najviše 0,1 % pota. Dobro: referenca je igra u barem 3,5 % slučajeva. Netočno: rjeđe od toga, uz gubitak od najviše 2 % pota. Greška: gubitak od najviše 8 %. Gruba greška: sve više od toga.",
    ],
    formulas: [
      {
        name: "Gubitak EV-a",
        expression: ["max EV − EV(odabrane)"],
        spoken: "Gubitak EV-a jednak je najvećem EV-u među opcijama minus EV opcije koju biraš.",
      },
      {
        name: "Gubitak EV-a, % pota",
        expression: { frac: ["gubitak EV-a", "pot"] },
        spoken: "Gubitak EV-a kao udio pota jednak je gubitku EV-a podijeljenom s potom prije odluke.",
      },
      {
        name: "Rezultat poteza",
        expression: ["max(0, 100 − 1000 × gubitak EV-a % pota)"],
        spoken: "Rezultat poteza jednak je 100 minus 1000 puta gubitak EV-a kao udio pota, i nikad nije manji od nule.",
      },
    ],
    example: {
      title: "Ocjena jedne odluke na flopu",
      setup: "Pot je 10 bb i pred tobom je bet. Referenca s tvojom rukom: fold 0 % (EV 0), call 52 % (EV 1,20 bb), raise 48 % (EV 1,17 bb).",
      steps: [
        "Raiseaš. 48 % je unutar 5 bodova od 52 %, pa je to Savršeno. Gubitak EV-a je 0,03 bb, 0,3 % pota, pa potez dobiva 100 − 1000 × 0,003 = 97.",
        "Umjesto toga foldaš. Referenca nikad ne folda, a gubitak EV-a je 1,20 bb, 12 % pota: Gruba greška, rezultat 0.",
        "Promijeni situaciju: referenca raisea samo u 2 % slučajeva, uz EV 1,05 bb. Raise sada gubi 0,15 bb, 1,5 % pota, i rjeđi je od 3,5 %: Netočno, rezultat 85.",
      ],
      takeaway: "Ocjena prati koliko izbor košta i koliko ga često referenca radi — nikad to je li ruka dobivena.",
    },
    mistakes: [
      "Procjenjivanje odluke po ishodu ruke.",
      "Čitanje „Dobro” kao „krivo”. Dobro je izbor koji radi i referenca, samo ne najčešće.",
      "Uspoređivanje gubitaka u big blindovima između potova različite veličine umjesto udjela u potu.",
      "Shvaćanje heurističke oznake kao ocjene. Oznaka kaže da provjera nije prošla; samo referentna strategija može reći koliko je to koštalo.",
    ],
    tryIt: "Postavi učestalosti i EV-ove reference, odaberi svoj potez i prati kako se mijenjaju ocjena i rezultat.",
  },

  "gto-vs-exploitative": {
    summary: "Ravnotežnu strategiju nije moguće pobijediti; eksploatativna jače pobjeđuje određenog protivnika, ali i nju se može eksploatirati.",
    definition: [
      "Teorijski optimalna (GTO) strategija polovica je ravnoteže: para strategija u kojem nijedan igrač ne može ništa dobiti mijenjajući svoju. Protiv nje protivnik u najboljem slučaju ne gubi ništa — svako odstupanje od ravnoteže može ga samo koštati ili ga ostaviti na nuli.",
      "Eksploatativna strategija namjerno odstupa da bi više zaradila na greškama određenog protivnika — više callova protiv nekoga tko previše blefira, više foldova protiv nekoga tko nikad ne blefira. Protiv tog protivnika zarađuje više, a zauzvrat je i sama otvorena za eksploataciju.",
    ],
    why: [
      "Referenca prema kojoj Rail ocjenjuje bliska je ravnoteži, jer je to jedini standard koji ne ovisi o tome protiv koga igraš. Ocjena mjeri udaljenost od te reference, a ne od najisplativije igre protiv tvog stvarnog protivnika.",
      "Zato namjeran exploit može dobiti ocjenu Netočno i svejedno biti ispravan. Odigraj ga kad imaš pravi read; ocjena ti govori koliko gubiš ako je read pogrešan.",
      "Ravnotežna igra ujedno je najbolji zadani izbor protiv protivnika o kojima ništa ne znaš: ne može izgubiti ni od koga, a profitira na svakoj grešci koju ravnoteža nikad ne radi.",
    ],
    formulas: [
      {
        name: "Indiferentni udio blefova",
        expression: { frac: ["bet", "pot + 2 × bet"] },
        spoken: "Udio blefova uz koji je bluff-catcher indiferentan jednak je betu podijeljenom zbrojem pota i dvostrukog beta.",
      },
    ],
    example: {
      title: "Bluff-catcher na riveru protiv tri protivnika",
      setup: "Pot je 10 bb i protivnik na riveru beta 7,5 bb. Imaš ruku koja pobjeđuje svaki blef i gubi od svakog value beta.",
      steps: [
        "Call riskira 7,5 bb da osvoji 17,5 bb. U ravnoteži igrač koji beta blefira u 7,5 / (10 + 15) = 30 % slučajeva, a call zarađuje točno 0: 0,30 × 17,5 − 0,70 × 7,5 = 0.",
        "Protiv nekoga tko blefira samo 15 %: 0,15 × 17,5 − 0,85 × 7,5 = −3,75 bb. Foldaj svaki bluff-catcher.",
        "Protiv nekoga tko blefira 45 %: 0,45 × 17,5 − 0,55 × 7,5 = +3,75 bb. Callaj svaki bluff-catcher.",
      ],
      takeaway: "Ravnoteža protivnika čini indiferentnim; exploit znači odabrati stranu kad on to nije. Read mora biti dobar, jer isto odstupanje gubi jednako mnogo protiv suprotne greške.",
    },
    mistakes: [
      "Uvjerenje da GTO znači najisplativiju igru. GTO je najsigurnija igra; protiv slabog protivnika dobar exploit zarađuje više.",
      "Exploit na premalom uzorku. Dva velika blefa su priča, a ne učestalost.",
      "Pretpostavka da miješana strategija znači nasumično igranje. Miks je svojstvo cijelog raspona; svaka ruka ima svoje razloge.",
      "Shvaćanje svakog poola protivnika kao istog. Greške koje se isplati eksploatirati razlikuju se po limitu i po poker sobi.",
    ],
    tryIt: "Pomiči protivnikov udio blefova i prati kako EV calla prelazi nulu točno na indiferentnom udjelu.",
  },

  position: {
    summary: "Igrati zadnji nakon flopa vrijedi novca: vidiš što protivnik radi prije nego što odlučiš.",
    definition: [
      "Nakon flopa prvi je na potezu igrač najbliže lijevo od buttona, a button je zadnji. Igrač koji je zadnji na potezu na svakom streetu je u poziciji (IP); drugi je izvan pozicije (OOP). Prije flopa redoslijed je drukčiji — blindovi su zadnji — ali su blindovi do kraja ruke izvan pozicije protiv svih.",
      "Pozicija je relativna. Cutoff je u poziciji protiv hijacka, a izvan pozicije protiv buttona.",
    ],
    why: [
      "U poziciji odlučuješ s više informacija: prije svog izbora već vidiš check ili bet. Možeš uzeti besplatnu kartu, checkati iza s rukom koja želi showdown ili betati kad protivnik pokaže slabost.",
      "Zbog te informacije ruke u poziciji realiziraju veći dio svog equityja, i zato je ista ruka raise s buttona, a fold s UTG-a.",
      "Iza tebe je i manje igrača koji se mogu probuditi s rukom. S buttona mogu djelovati još samo blindovi; s UTG-a njih pet.",
    ],
    formulas: [
      {
        name: "Vjerojatnost da svi iza foldaju",
        expression: ["(1 − p)", { sup: "n" }],
        spoken: "Vjerojatnost da svi igrači iza foldaju jednaka je jedan minus p, na potenciju n.",
        where: [
          ["p", "koliko često svaki igrač iza nastavlja"],
          ["n", "koliko je igrača još na potezu"],
        ],
      },
    ],
    example: {
      title: "Isti steal s dva sjedala",
      setup: "Otvaraš na 2,5 bb da osvojiš 1,5 bb u blindovima, s rukom čiji equity nije vrijedan spomena ako dobiješ call. Recimo da svaki igrač iza tebe nastavlja u 10 % slučajeva.",
      steps: [
        "Steal je na nuli kad svi foldaju u 2,5 / (2,5 + 1,5) = 62,5 % slučajeva.",
        "S UTG-a iza tebe je pet igrača: 0,9⁵ ≈ 59 % da svi foldaju. Ispod 62,5 % — steal koji gubi.",
        "S buttona iza tebe su dva igrača: 0,9² = 81 %. Udobno iznad 62,5 %.",
      ],
      takeaway: "Ista ruka, ista veličina, isti protivnici: samo sjedalo pretvara steal koji gubi u steal koji zarađuje. Zato se rasponi otvaranja šire prema buttonu.",
    },
    mistakes: [
      "Igranje istog raspona sa svakog sjedala.",
      "Callanje raiseova izvan pozicije s rukama kojima treba pozicija da bi realizirale svoj equity.",
      "Zaboravljanje da je pozicija relativna: cutoff koji otvara izvan je pozicije protiv buttona.",
    ],
    tryIt: "Odaberi ruku protiv raspona i pomiči faktor realizacije: u poziciji raste, izvan pozicije pada.",
  },
};

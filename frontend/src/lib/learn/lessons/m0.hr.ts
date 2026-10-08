import type { LessonBodies } from "./types";

/**
 * Reference pages since L1.1 (`/learn/reference/<id>`, `REFERENCE_IDS`):
 * L1's M0 — orientation, out of the course map, kept read-only.
 *
 * M0 — orijentacija, hrvatski. Ista struktura i isti brojevi kao m0.en.ts;
 * `tests/test/course.test.ts` provjerava i jedno i drugo. Pokerske riječi
 * ostaju one koje koriste hrvatski igrači; čitatelju se obraćamo s „ti”.
 */
export const m0Hr: LessonBodies<"how-rail-teaches" | "gto-mixing-and-simplifying" | "reading-rail-reports" | "variance-bankroll-and-tilt"> = {
  "how-rail-teaches": {
    sections: [
      {
        heading: "Krug, a ne gradivo",
        blocks: [
          "Čitanje o pokeru djeluje kao napredak, ali znanje se primi tek kad ga upotrijebiš za stolom i pogledaš što si napravio. Rail je složen oko kruga koji radi upravo to, a svaka lekcija jedan je njegov obrt.",
          {
            list: [
              "Uči: pročitaj kratku lekciju i odgovori na njezina pitanja prije nego što se otvori objašnjenje.",
              "Vježbaj: primijeni ideju na situacijama koje Rail generira i odmah ocjenjuje.",
              "Igraj: odnesi to u svoje igre.",
              "Pregledaj: učitaj ruke i pusti analizu da ocijeni svaku odluku.",
              "Ponovi: tvoji najskuplji leakovi pokazuju sljedeću lekciju.",
            ],
          },
          "Ništa nije zaključano. Karta tečaja predlaže redoslijed, ali svaku lekciju možeš otvoriti kad god hoćeš, a tvoji izvještaji često su najbolji putokaz kamo dalje.",
        ],
      },
      {
        heading: "Što ocjena mjeri",
        blocks: [
          "Svaku odluku koju ocjenjuje Rail uspoređuje s referentnom strategijom: preflop s chartovima, nakon flopa s vlastitim solverom. Za tvoju točnu ruku referenca svakoj opciji daje učestalost (koliko je često igra) i EV (koliko u prosjeku vrijedi, u big blindovima).",
          "Tvoj gubitak EV-a razlika je između EV-a najbolje opcije i EV-a one koju si odabrao. Rail ga mjeri kao udio pota, jer 2 bb u malom potu znače puno više nego u ogromnom. Konceptna stranica „EV, gubitak EV-a i kako Rail ocjenjuje” prolazi sve to do kraja.",
          {
            list: [
              "Savršeno: referenca tvoju opciju igra unutar 5 postotnih bodova od svoje najčešće, ili si izgubio najviše 0,1 % pota.",
              "Dobro: referenca tvoju opciju igra u barem 3,5 % slučajeva.",
              "Netočno: igra je rjeđe od toga, a gubitak je do 2 % pota.",
              "Greška: gubitak do 8 % pota.",
              "Gruba greška: gubitak veći od 8 % pota.",
            ],
          },
          {
            checkpoint: {
              question:
                "Pot je 20 bb. Referenca calla u 70 % slučajeva (EV 3,00 bb), a raisea u 30 % (EV 2,90 bb). Ti raiseaš. Koja je ocjena?",
              options: ["Savršeno", "Dobro", "Netočno", "Greška"],
              answer: 1,
              explain:
                "30 % je više od 5 bodova ispod 70 %, pa po učestalosti nije Savršeno. Gubitak EV-a je 3,00 − 2,90 = 0,10 bb, odnosno 0,5 % pota: više od 0,1 %, pa nije Savršeno ni po EV-u. Referenca ipak raisea u više od 3,5 % slučajeva, pa je ocjena Dobro.",
              math: { fn: "ratio", args: [0.1, 20], value: 0.005 },
            },
          },
          {
            widget: { id: "grading" },
            caption: "Postavi učestalosti i EV-ove reference, odaberi svoju opciju i prati kako se mijenjaju ocjena i rezultat. Probaj EV-ove izjednačiti gotovo do kraja i vidi koliko tada malo znače učestalosti.",
          },
          {
            checkpoint: {
              question: "Ista situacija, ali ovaj put foldaš. Referenca nikad ne folda, a fold vrijedi 0. Koja je ocjena?",
              options: ["Netočno", "Greška", "Gruba greška"],
              answer: 2,
              explain: "Call je vrijedio 3 bb, pa foldom odustaješ od svega toga: 3 / 20 = 15 % pota, daleko preko granice od 8 %. To je Gruba greška.",
              math: { fn: "ratio", args: [3, 20], value: 0.15 },
            },
          },
        ],
      },
      {
        heading: "Uči situacije na koje najčešće nailaziš",
        blocks: [
          "Svaka ruka koju igraš počinje preflop odlukom, manje ih stigne do flopa, a još manje do rivera. Zato se mali preflop leak ponavlja puno češće od neobičnog river leaka, i njegov popravak vrijedi više.",
          "Kreni od situacija koje se javljaju u svakoj sesiji: open, obrana blindova, prvi bet nakon flopa. Izvještaji ti pokazuju koja te od njih najviše košta; lekcije o njima idu prve.",
        ],
      },
      {
        heading: "Kratko, redovito i izmiješano",
        blocks: [
          "Dvadeset minuta usredotočenog rada većinu dana bolje je od jedne duge sesije tjedno. Pamćenje zadrži ono čemu se vraćaš nakon pauze, a kratke sesije drže pažnju oštrom.",
          "Miješaj vježbu. Deset različitih situacija zaredom čini se težim od deset istih, i baš zato više nauče: za stolom nikad ne znaš koja situacija dolazi sljedeća. Railove vježbe zato dijele raznolike situacije.",
          "Dok gradiš osnove, drži se jednog formata. Sve ovdje je cash: 6-max i full ring, uglavnom na 100 big blindova, a dublji stackovi i live igre dolaze kasnije u tečaju.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Uči, vježbaj, igraj, pregledaj, ponovi: jedan obrt kruga po lekciji.",
        "Odluku sudi po gubitku EV-a, a ne po tome jesi li dobio ruku.",
        "Popravi situacije iz svake sesije prije rijetkih.",
        "Kratke, redovite sesije s izmiješanim situacijama bolje su od dugih blokova jedne situacije.",
      ],
      breaks: [
        "Ocjena te uspoređuje s referentnom strategijom, a ne s najboljom igrom protiv tvog stvarnog protivnika. Namjeran exploit može dobiti Netočno i svejedno biti ispravan.",
        "Gdje Rail za situaciju nema referencu, ne ocjenjuje je, pa čist izvještaj tamo znači „nije izmjereno”, a ne „dobro odigrano”.",
      ],
    },
    exercises: {
      "grade-quiz":
        "Šest malih tablica opcija, svaka s potom, učestalošću i EV-om reference za svaku opciju te odabranom opcijom. Reci koju joj ocjenu daje Rail, a zatim pogledaj izračunat gubitak EV-a.",
      placement:
        "Kratki test razine stiže uskoro: nekoliko izmiješanih pitanja koja predlažu gdje u tečaju početi. Do tada kreni od pot oddsa ili od onoga na što pokazuju tvoji izvještaji.",
    },
    checks: [{ fn: "sum", args: [3, -2.9], value: 0.1 }],
  },

  "gto-mixing-and-simplifying": {
    sections: [
      {
        heading: "Što ravnoteža obećava",
        blocks: [
          "Ravnoteža je par strategija u kojem nijedan igrač ne može ništa dobiti mijenjajući svoju. Igraj svoju polovicu i nijedan te protivnik ne može pobijediti: najbolje što može jest ne gubiti. To ljudi misle kad kažu GTO.",
          "To nije isto što i najisplativija igra protiv svakoga. Protiv protivnika s jasnim leakom strategija koja se nasloni na taj leak zarađuje više, uz cijenu da je i sama ranjiva.",
          {
            checkpoint: {
              question: "Protivnik na riveru blefira daleko previše. Je li ravnotežna strategija najisplativiji odgovor?",
              options: ["Da: to je najbolja igra protiv bilo koga", "Ne: protiv njega ne može izgubiti, ali više callova zaradilo bi više"],
              answer: 1,
              explain:
                "Ravnoteža jamči da ne gubiš ni od koje strategije. Protiv nekoga tko previše blefira češći call od ravnotežnog zarađuje više, pod uvjetom da je read točan.",
            },
          },
        ],
      },
      {
        heading: "Zašto solver miješa",
        blocks: [
          "Da je s nekom rukom jedna akcija jasno bolja, solver bi je birao svaki put. Ruku dijeli između akcija samo kad vrijede jednako ili gotovo jednako. Miks ti zato govori nešto korisno: akcije su blizu po EV-u.",
          "Klasičan primjer je bluff-catcher na riveru. Kad je pot 10 bb, a bet 7,5 bb, ravnotežni raspon igrača koji beta blefira u 7,5 / (10 + 15) = 30 % slučajeva. Call tada u 30 % slučajeva osvaja 17,5 bb, a u ostalima gubi 7,5 bb: 0,3 × 17,5 = 5,25 i 0,7 × 7,5 = 5,25. Call vrijedi točno nula, kao i fold, pa miješanje ne košta ništa.",
          {
            widget: { id: "bluff-catcher", pot: 10, bet: 7.5, share: 0.3 },
            caption: "Pomakni udio blefova s 30 % i jedna akcija jasno odmakne. Samo u točki ravnoteže call i fold vrijede isto.",
          },
        ],
      },
      {
        heading: "Ocjena mjeri EV, a ne učestalost",
        blocks: [
          "Budući da su miješane akcije blizu po EV-u, Rail te ne kažnjava kad odabereš rjeđu. Ocjena prati koliko je EV-a tvoj izbor ostavio na stolu, a učestalost odlučuje samo između Savršeno i Dobro kad je gubitak malen.",
          {
            checkpoint: {
              question:
                "Pot je 25 bb. Referenca beta u 60 % slučajeva (EV 4,10 bb), a checka u 40 % (EV 4,05 bb). Ti checkaš. Koja je ocjena?",
              options: ["Savršeno", "Dobro", "Netočno"],
              answer: 1,
              explain:
                "40 % je više od 5 bodova ispod 60 %, a gubitak od 0,05 bb iznosi 0,2 % pota, malo preko 0,1 % koji se broji kao ništa. Referenca checka u puno više od 3,5 % slučajeva, pa je check Dobro: sasvim dobra igra, samo ne glavna.",
              math: { fn: "ratio", args: [0.05, 25], value: 0.002 },
            },
          },
          "Usporedi s opcijom koju referenca igra u samo 2 % slučajeva, a koja gubi 1,5 % pota: to je Netočno. Opcija koju nikad ne igra, a gubi 5 % pota, Greška je. Što je veća razlika u EV-u, to je ocjena lošija, što god govorile učestalosti.",
          "Ako uvijek biraš opciju od 40 %, nijedna pojedinačna ruka neće dobiti lošu ocjenu. Taj se obrazac umjesto toga vidi u izvještajima, gdje mu je i mjesto.",
        ],
      },
      {
        heading: "Pojednostavljenje malo košta kad su EV-ovi blizu",
        blocks: [
          "Nitko za stolom ne može ponoviti solverove točne mikseve, a i ne treba. Kad su dvije akcije blizu, uvijek birati jednu od njih košta samo tu malu razliku, pomnoženu s brojem puta koliko si u toj situaciji.",
          {
            checkpoint: {
              question:
                "Referenca s nekom rukom beta i checka otprilike pola-pola, a dva EV-a razlikuju se najviše 0,02 bb. Odlučiš je uvijek checkati. Koliko te to najviše košta kroz 500 puta u toj situaciji?",
              options: ["Oko 10 bb", "Oko 100 bb", "Oko 250 bb"],
              answer: 0,
              explain: "Najviše 0,02 bb svaki put: 0,02 × 500 = 10 bb kroz 500 ruku u toj situaciji. Takvo je pojednostavljenje gotovo besplatno.",
              math: { fn: "product", args: [0.02, 500], value: 10 },
            },
          },
          "Ista logika govori i gdje ne pojednostavljivati. Kad je jedna opcija daleko ispred, uvijek birati drugu pravi je leak, i ocjene će ti to reći u svakoj ruci.",
        ],
      },
      {
        heading: "Polazište za exploit",
        blocks: [
          "Ravnotežu shvati kao zadanu igru protiv igrača o kojima ništa ne znaš: ne može izgubiti ni od koga, a zarađuje na svakoj njihovoj grešci. Odstupi kad imaš pravi read, i to u smjeru njihova leaka.",
          "Kad odstupiš, ocjena ti govori koliko exploit košta ako je read pogrešan. Mali trošak za velik očekivani dobitak dobra je zamjena; velik trošak na tankom readu nije.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Miks znači da su akcije blizu po EV-u; birati češću ili jednostavniju malo košta.",
        "Izbor sudi po gubitku EV-a. Učestalost samo razdvaja Savršeno od Dobro.",
        "Trošak pojednostavljenja je razlika u EV-u puta broj puta koliko si u toj situaciji.",
        "Kreni od ravnoteže i odstupi samo uz read, prema protivnikovu leaku.",
      ],
      breaks: [
        "Miks u solverovu prikazu može skrivati ruke koje uopće nisu blizu: provjeri EV svoje točne ruke, a ne prosjek raspona.",
        "Protiv igrača s velikim, dokazanim leakom ravnotežna igra ostavlja novac na stolu; tada se exploit isplati.",
      ],
    },
    exercises: {
      "close-calls":
        "Pet tablica opcija složenih oko tijesnih odluka: dvije ili tri akcije koje referenca igra, s bliskim EV-ovima. Odredi ocjenu svakog izbora i primijeti koliko je često rjeđa opcija i dalje Dobro ili Savršeno.",
      "mixed-rivers":
        "Četiri river situacije izabrane prema tijesnim odlukama. Railov solver ocjenjuje tvoj izbor; kad su dvije akcije blizu po EV-u, obje mogu dobiti Dobro ili Savršeno, a tablica opcija pokazuje koliko ih malo razdvaja.",
    },
    checks: [
      { fn: "product", args: [2, 7.5], value: 15 },
      { fn: "bluffShare", args: [10, 7.5], value: 0.3 },
      { fn: "sum", args: [10, 7.5], value: 17.5 },
      { fn: "product", args: [0.3, 17.5], value: 5.25 },
      { fn: "product", args: [0.7, 7.5], value: 5.25 },
      { fn: "bluffCatcherEv", args: [10, 7.5, 0.3], value: 0, tolerance: 0.001 },
    ],
  },

  "reading-rail-reports": {
    sections: [
      {
        heading: "Pregled: jedan broj za to kako igraš",
        blocks: [
          "Pregled u Analizi cijeli tvoj uzorak stavlja na jedan ekran: rezultat, gubitak EV-a na 100 ruku, kako se tvoji potezi dijele na pet ocjena i pokrivenost, odnosno koliko je ruku potpuno analizirano, djelomično ili nikako, i zašto.",
          "Gubitak EV-a na 100 ruku broj je koji treba pratiti. Zbraja EV koji si dao u svakoj ocijenjenoj odluci i svodi ga na 100 ruku, pa se uzorci različitih veličina pošteno uspoređuju.",
          {
            formula: {
              name: "Izgubljeni EV na 100 ruku",
              expression: { frac: ["izgubljeni EV (bb) × 100", "ruke"] },
              spoken: "Izgubljeni EV na 100 ruku jednak je izgubljenom EV-u u big blindovima, puta 100, podijeljeno s brojem ruku.",
            },
          },
          "Recimo da si kroz 1.200 ruku izgubio 36 bb EV-a. To je 12 stotina ruku, pa je 36 / 12 = 3 bb na 100.",
          {
            checkpoint: {
              question: "Kroz 3.000 ruku izgubio si 45 bb EV-a. Koliki je tvoj gubitak EV-a na 100 ruku?",
              options: ["0,15 bb", "1,5 bb", "15 bb"],
              answer: 1,
              explain: "3.000 ruku je 30 stotina, pa je 45 / 30 = 1,5 bb na 100.",
              math: { fn: "ratio", args: [45, 30], value: 1.5 },
            },
          },
        ],
      },
      {
        heading: "Raščlamba: kamo odlazi",
        blocks: [
          "Raščlamba iste brojke dijeli po streetu, poziciji, vrsti pota i preflop situaciji, s istim filtrima kao tvoja statistika: datumi, ulozi, soba i igra. Odgovara na prvo pitanje koje vrijedi postaviti: curi li EV preflop, na flopu, s jedne pozicije?",
        ],
      },
      {
        heading: "Leakovi, poredani po tome koliko koštaju",
        blocks: [
          "Leak je situacija plus jedan krivi potez u njoj: street, situacija i pozicije, te akcija različita od najbolje u referenci, ili prava akcija krive veličine. Tražilica leakova slaže ih po ukupnom izgubljenom EV-u, u big blindovima.",
          "Ukupni EV pravi je redoslijed jer broji i koliko je greška teška i koliko je često radiš. Mala greška u situaciji koju imaš svake sesije može koštati više od velike koju si napravio jednom.",
          {
            checkpoint: {
              question: "Leak A svaki put gubi 0,4 bb i dogodio se 50 puta. Leak B bio je jedna greška od 12 bb. Koji košta više?",
              options: ["Leak A", "Leak B", "Otprilike su jednaki"],
              answer: 0,
              explain: "Leak A koštao je 0,4 × 50 = 20 bb, naspram 12 bb za leak B. Usto je navika, pa će koštati sve dok ga ne popraviš.",
              math: { fn: "product", args: [0.4, 50], value: 20 },
            },
          },
          "Same razlike u učestalosti nisu leakovi. Ako miješanu akciju biraš češće od reference, a svaka je ta odluka dobila Savršeno, ništa nije izgubljeno i tražilica to izostavlja. Izostavlja i leakove manje od ukupno 0,05 bb.",
          {
            widget: { id: "grading" },
            caption: "Postavi dvije opcije bliske po EV-u, a zatim pomiči učestalosti: ocjena se jedva mijenja. Povećaj razliku u EV-u i brzo pada.",
          },
        ],
      },
      {
        heading: "Koliko je tražilica sigurna?",
        blocks: [
          "Leak sagrađen na tri ruke može biti tri nesretne situacije, a ne navika. Zato svaki leak ima razinu pouzdanosti prema tome koliko si odluka donio u situaciji i koliko su ih bile greške.",
          {
            list: [
              "Visoka pouzdanost: barem 50 odluka u situaciji i 5 grešaka.",
              "Srednja pouzdanost: barem 20 odluka i 2 greške.",
              "Niska pouzdanost: manje od toga. Može biti i jedna ruka; otvori ruke prije nego što išta mijenjaš.",
            ],
          },
          "Situacije s vrlo malo odluka spajaju se u širu skupinu, primjerice istu situaciju s drugih pozicija, kako bi ipak nešto rekle. Trendovi koji uspoređuju razdoblja kažu „Premalo za reći” kad nema dovoljno igre da se promjena razlikuje od sreće.",
        ],
      },
      {
        heading: "Od izvještaja do plana",
        blocks: [
          "Plan učenja uzima tri najskuplja područja za koja uzorak jamči, srednje ili visoke pouzdanosti. Tek ako ih je manje, popunjava se tanjima, označenima kao „Okvirno”, uz napomenu da prvo pregledaš ruke.",
          "Uz svako područje dolaze koncepti za čitanje, trening postavljen na tu situaciju i ruke za pregled. Time se krug zatvara: izvještaj ti govori koju lekciju uzeti sljedeću.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Prati gubitak EV-a na 100 ruku: uspoređuje uzorke bilo koje veličine.",
        "Leakove rješavaj redom po ukupnom izgubljenom EV-u, a ne po tome koliko je ruka boljela.",
        "Razlika u učestalosti važna je samo kad košta EV.",
        "Otvori ruke iza leaka niske pouzdanosti prije nego što mijenjaš igru.",
      ],
      breaks: [
        "Situacije koje analiza ne pokriva nisu u zbrojevima, pa čist izvještaj može skrivati leak koji Rail još ne mjeri.",
        "Leak nisko na listi jer rijetko stigneš u tu situaciju može postati važan kad takvih situacija igraš više, na primjer na novom limitu ili za stolom drukčije veličine.",
      ],
    },
    exercises: {
      "per-100":
        "Pet računa poput onih u pregledu: broj ruku i EV izgubljen kroz njih. Izračunaj izgubljeni EV na 100 ruku; odgovor unutar 3 % od točnog se priznaje.",
      "your-hands":
        "Tvoje najskuplje odluke, najgora prva, ponovno odigrane bez ishoda. Odluči što bi napravio prije nego što vidiš što si napravio.",
    },
    checks: [
      { fn: "ratio", args: [1200, 100], value: 12 },
      { fn: "ratio", args: [36, 12], value: 3 },
      { fn: "ratio", args: [3000, 100], value: 30 },
    ],
  },

  "variance-bankroll-and-tilt": {
    sections: [
      {
        heading: "Rezultat su odluke plus sreća",
        blocks: [
          "Svaki rezultat miješa dvije stvari: kvalitetu tvojih odluka i karte koje su došle. U jednoj sesiji karte lako pobjeđuju. Dobar call može izgubiti, loš može dobiti, a kraj ruke ne govori ništa o tome što je bio.",
          {
            checkpoint: {
              question: "Callaš all-in s više equityja nego što cijena traži i izgubiš ruku. Je li call bio greška?",
              options: ["Da: izgubio je", "Ne: u prosjeku zarađuje", "Samo ako se ponovi"],
              answer: 1,
              explain:
                "Call se sudi po EV-u u trenutku kad ga donosiš. S više equityja nego što cijena traži u prosjeku zarađuje; ovaj put runout je otišao na drugu stranu.",
            },
          },
        ],
      },
      {
        heading: "All-in EV: rezultat koji si zaradio",
        blocks: [
          "Kad novac uđe prije rivera, možeš izmjeriti što je odluka zaradila umjesto što su napravile karte. EV calla je tvoj equity puta konačni pot, minus ono što si uložio.",
          {
            formula: {
              name: "EV calla na all-in",
              expression: ["equity × konačni pot − call"],
              spoken: "EV calla na all-in jednak je tvojem equityju pomnoženom s konačnim potom, minus call.",
              where: [
                ["konačni pot", "sve što je u sredini nakon tvog calla"],
                ["call", "koliko te call košta"],
              ],
            },
          },
          "Recimo da je u sredini 10 bb, a protivnik gurne još 40 bb, pa je pot 50 bb, a call 40 bb. Ako callaš, konačni pot je 90 bb. Uz 50 % equityja call vrijedi 0,5 × 90 − 40 = 45 − 40 = +5 bb, dobio ti ovu ruku ili ne. Da bi bio na nuli, treba 40 / 90, oko 44,4 %.",
          {
            widget: { id: "bet-math", focus: "pot-odds", pot: 50, bet: 40, share: 0.5 },
            caption: "Pot ovdje uključuje shove, a call je ono što ti ulažeš. Pomiči svoj equity i prati EV calla; to je broj koji all-in vrijedi prije nego što se podijele karte.",
          },
          {
            checkpoint: {
              question: "U sredini je 10 bb, a protivnik gurne 20 bb. Imaš 45 % equityja. Koliko vrijedi call?",
              options: ["+2,5 bb", "−2,5 bb", "+22,5 bb"],
              answer: 0,
              explain: "Konačni pot je 10 + 20 + 20 = 50 bb. Call vrijedi 0,45 × 50 − 20 = 22,5 − 20 = +2,5 bb.",
              math: { fn: "callEv", args: [30, 20, 0.45], value: 2.5 },
            },
          },
          "Railov graf u statistici ima liniju All-in EV: tvoje rezultate s isplatom svakog all-in runouta po equityju. Kad je ona osjetno iznad stvarnih rezultata, u tim potovima nisi imao sreće; odluke su bile u redu.",
        ],
      },
      {
        heading: "Koliko dugo traje sreća",
        blocks: [
          "Rezultati se smiruju sporo. Nekoliko tisuća ruku može daleko odnijeti gore ili dolje igrača bilo koje razine, a i puno veći uzorci ostavljaju sreći mnogo prostora.",
          "Tvoj gubitak EV-a na 100 ruku smiruje se puno brže, jer ne ovisi o tome koje su karte došle. Svaku odluku uspoređuje s alternativama u istoj situaciji, a ruka obično ima nekoliko odluka. Zato je to Railov najbolji signal toga koliko dobro igraš.",
        ],
      },
      {
        heading: "Bankroll i stop-loss: pravila koja sam postavljaš",
        blocks: [
          "Oscilacije su normalne, pa unaprijed, dok si miran, odluči kako ćeš s njima. To su osobna pravila i brojke možeš postaviti samo ti.",
          {
            list: [
              "Novac s kojim igraš drži odvojeno i koristi samo novac koji si možeš priuštiti izgubiti.",
              "Igraj uloge na kojima uobičajeni niz gubitaka ne mijenja tvoju igru. Ako zbog gubitka igraš prestrašeno, ulog ti je trenutno previsok.",
              "Odaberi stop-loss za sesiju, u buy-inovima ili big blindovima, i stani kad ga dosegneš, kakav god bio osjećaj.",
              "Kada ideš gore ili dolje po ulozima odluči prije nego što oscilacija dođe, a ne usred nje.",
            ],
          },
        ],
      },
      {
        heading: "Tilt se vidi u brojkama",
        blocks: [
          "Tilt nije samo ljutnja: to su tvoje odluke koje postaju lošije nakon što nešto krene po zlu. Zato se može izmjeriti. Stranica napretka može podijeliti gubitak EV-a po sesijama, a usporediti treba sesije nakon velike izgubljene ruke.",
          "Ako ti gubitak EV-a na 100 ruku skoči nakon velikih gubitaka, to je najjači razlog za stop-loss pravilo. Karte ne kontroliraš; kako odigraš sljedeću ruku, kontroliraš.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Odluku sudi po njezinu EV-u u trenutku kad si je donio, nikad po tome kako je ruka završila.",
        "EV calla na all-in je equity × konačni pot − call.",
        "Gubitak EV-a na 100 ruku brži je i stabilniji signal vještine od rezultata.",
        "Pravila za bankroll i stop-loss postavi prije sesije, a ne usred oscilacije.",
      ],
      breaks: [
        "All-in EV uklanja sreću samo iz all-in potova; sreća u rukama koje završe foldom ili dođu do showdowna bez all-ina ostaje u rezultatima.",
        "Gubitak EV-a uspoređuje te s referencom, pa ga isplativ exploit može povećati dok ti se rezultati poboljšavaju.",
      ],
    },
    exercises: {
      "allin-ev":
        "Šest callova na all-in: novac koji je već u sredini, shove pred kojim si i tvoj equity. Izračunaj EV calla, equity × konačni pot − call, prije nego što ga kalkulator pokaže.",
      "your-hands":
        "Tvoje najskuplje odluke, ponovno odigrane bez ishoda. Svaku sudi samo po odluci, prije nego što vidiš kako je završila.",
    },
    checks: [
      { fn: "sum", args: [10, 40], value: 50 },
      { fn: "sum", args: [50, 40], value: 90 },
      { fn: "product", args: [0.5, 90], value: 45 },
      { fn: "callEv", args: [50, 40, 0.5], value: 5 },
      { fn: "requiredEquity", args: [50, 40], value: 0.444 },
      { fn: "sum", args: [10, 20, 20], value: 50 },
      { fn: "product", args: [0.45, 50], value: 22.5 },
    ],
  },
};

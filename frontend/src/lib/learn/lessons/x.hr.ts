import type { LessonBodies } from "./types";

/**
 * Staza 5 — exploiti, hrvatski (Learn L4): X1 čitanje ljudi, X2 pool, X3
 * exploit laboratorij, X4 uživo i duboko. Ista struktura kao `x.en.ts`, s
 * istim brojevima (decimalni zarez) i istim `checks`; poker riječi ostaju
 * one kojima se služe hrvatski igrači. Isto pravilo: broj o protivniku ili o
 * "poolu" dolazi samo iz učenikove vlastite statistike (s veličinom uzorka),
 * iz Railovih rješenja (laboratorij, igra-igračka izračunata ručno) ili nije
 * broj nego teorija.
 */
export const xHr: LessonBodies<
  | "player-profiles"
  | "reading-hud-stats"
  | "population-exploits"
  | "exploiting-overfolders"
  | "exploiting-calling-stations"
  | "exploiting-aggressive-players"
  | "underbluffed-rivers"
  | "node-locking-in-rail"
  | "when-not-to-exploit"
  | "live-game-dynamics"
  | "straddle-preflop"
  | "straddle-postflop-low-spr"
  | "deep-stacks-200bb"
> = {
  /* ------------------------------------------------------------ X1 čitanje ljudi */

  "player-profiles": {
    sections: [
      {
        heading: "Dva pitanja o igraču",
        blocks: [
          "Svaka etiketa koju igrači lijepe jedni drugima odgovara na dva pitanja. Koliko ruku ovaj igrač igra? I kad igra ruku, beta li i raisea ili checka i calla? Tight ili loose prvi je odgovor, pasivan ili agresivan drugi, a četiri kuta su poznati tipovi: tight i pasivan, loose i pasivan (calling station), tight i agresivan, loose i agresivan (manijak, na samom kraju).",
          "Railov panel protivnika odgovara na oba pitanja iz tvojih ruku: koliko često igrač ulaže novac i raisea prije flopa za prvo pitanje, i koliko često beta ili raisea nakon flopa za drugo. Broj vrijedi koliko i prilike iza njega. Igrač koji je odigrao 40 % od 100 ruku mogao bi jednako biti igrač od 30 % ili od 50 %: interval od 95 % seže oko 9,6 bodova na svaku stranu. Sljedeća lekcija tu aritmetiku radi kako treba.",
          {
            widget: { id: "sample-size", share: 0.4, count: 100 },
            caption: "Statistika od 40 % kroz 100 ruku. Pomakni broj ruku i gledaj koliko brzo se interval sužava.",
          },
        ],
      },
      {
        heading: "Svaki tip ima jednu glavnu prilagodbu",
        blocks: [
          "Tip je koristan samo ako mijenja ono što radiš. Railov exploit laboratorij zaključava jednu protivnikovu sklonost na riveru koji rješava i računa najbolji odgovor; kroz mnogo rivera prilagodbe koje nalazi su ove:",
          {
            list: [
              "Igrač koji previše folda na betove: blefiraj s daleko više ruku koje ne mogu dobiti na showdownu, pretvori slabe parove i as kao najvišu kartu u blefove, a najjače ruke betaj manje.",
              "Igrač koji previše calla: prestani blefirati, jake ruke betaj veće, a betaj i neke srednje parove koje bi protiv solvea checkao.",
              "Igrač koji nikad ne raisea: betaj tanje, jer tanki bet ništa ne kažnjava.",
              "Igrač koji premalo blefira: foldaj više svojih bluff-catchera.",
              "Igrač koji previše blefira: callaj šire sa svojim parovima i asom kao najvišom kartom.",
            ],
          },
          {
            checkpoint: {
              question: "Protiv igrača koji daleko prečesto calla river betove, što Railov najbolji odgovor radi sa svojim promašenim drawovima?",
              options: ["Beta ih velikim betom", "Checka ih", "Beta ih malim betom"],
              answer: 1,
              explain:
                "Promašeni draw dobiva samo kad protivnik folda. Protiv igrača koji rijetko folda svaki blef većinom gubi bet, pa ih najbolji odgovor checka i odustaje — a novac seli u value betove, koji se češće plaćaju.",
            },
          },
        ],
      },
      {
        heading: "Tip je procjena, a ne činjenica",
        blocks: [
          "Smjestiti igrača u kut znači pogađati kako igra situacije koje još nisi vidio. Svaka prilagodba gore nešto vraća ako je pogađanje krivo, a laboratorij mjeri koliko (lekcija X3-L1). Etiketa na tankom uzorku, ili ona koju je igrač prerastao, gora je od nikakve: osnova je ono što igraš dok procjena nije jasna.",
          {
            note: {
              tone: "approximate",
              text: "Prilagodbe dolaze iz Railova exploit laboratorija: jedna sklonost zaključana na riveru riješenom na zahtjev, ostatak protivnikove strategije kakav je u solveu, i najbolji odgovor protiv toga. Rasponi počivaju na Railovu modelu sužavanja, a zaključavanje je model igrača, a ne sam igrač.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Postavi dva pitanja: koliko ruku i koliko agresivno.",
        "Pretvori tip u jednu prilagodbu, inače je samo etiketa.",
        "Protiv onih koji foldaju blefiraj više; protiv onih koji callaju više value betaj, a manje blefiraj.",
        "Pročitaj uzorak prije broja.",
      ],
      breaks: [
        "Igrač može biti loose prije flopa a tight nakon njega: određuj ga po situaciji u kojoj si.",
        "Igrači se mijenjaju tijekom sesije; etiketa od prošlog mjeseca večeras može biti kriva.",
      ],
    },
    exercises: {
      "profile-reads": "Četiri rivera, svaki s jednom od pet zaključanih procjena: odigraj ruku kako je igra Railov najbolji odgovor.",
      "profile-quiz": "Planirano: imenuj tipove svojih protivnika iz njihove statistike.",
    },
    checks: [{ fn: "marginOfError", args: [0.4, 100], value: 0.096 }],
  },

  "reading-hud-stats": {
    sections: [
      {
        heading: "Što koji broj broji",
        blocks: [
          "Svaka statistika u panelu protivnika broj je kroz prilike, a prilike nisu ruke. Ulaganje novca prije flopa ima priliku u svakoj ruci; 3-bet samo kad je netko prije otvorio; fold na c-bet na flopu samo kad je callao preflop i onda na flopu dočekao raiserov bet. Igrač na kojem imaš 300 ruku možda je na c-bet naišao tek nekoliko desetaka puta.",
          {
            list: [
              "Uložio novac i raiseao prije flopa: prilika u svakoj podijeljenoj ruci.",
              "3-bet: prilika svaki put kad je netko otvorio prije njega.",
              "Foldao na 3-bet: prilika svaki put kad je raiseao i dobio 3-bet.",
              "C-bet na flopu: prilika svaki put kad je raiseao preflop i vidio flop.",
              "Foldao na c-bet na flopu: prilika svaki put kad je naišao na njega.",
              "Došao do showdowna i dobio na showdownu: prilike kad je vidio flop i kad je stigao do showdowna.",
              "Betao ili raiseao nakon flopa: prilika u svakoj odluci nakon flopa.",
            ],
          },
        ],
      },
      {
        heading: "Koliko istina može biti široka",
        blocks: [
          "Statistika viđena p puta kroz n prilika može odstupati od igračeve stvarne učestalosti oko 1,96 × √(p(1 − p) / n) na svaku stranu, 95 puta od 100. Na 30 % kroz 50 prilika to je ± 12,7 bodova: odgovara bilo što od oko 17 % do 43 %. Kroz 500 prilika to je ± 4,0.",
          "Da bi bila unutar ± 5 bodova, statistici blizu 30 % treba oko 322,7 prilika, recimo 323. Prepoloviti marginu na ± 2,5 traži 1290,8: četiri puta više. Statistike blizu rubova brže se smiruju: 10 % kroz 50 prilika već je ± 8,3.",
          {
            widget: { id: "sample-size", share: 0.3, count: 50 },
            caption: "Statistika od 30 % kroz 50 prilika. Nađi koliko prilika je dovodi unutar ± 5 bodova.",
          },
          {
            checkpoint: {
              question: "Igrač je foldao na 6 od 10 c-betova na flopu na koje je naišao. Što je najbliže intervalu od 95 % za njegove foldove?",
              options: ["60 % ± 5 bodova", "60 % ± 15 bodova", "60 % ± 30 bodova"],
              answer: 2,
              explain: "1,96 × √(0,6 × 0,4 / 10) je oko 0,30: uz deset prilika odgovara bilo što od 30 % do 90 %. Deset c-betova ne govori gotovo ništa.",
              math: { fn: "marginOfError", args: [0.6, 10], value: 0.304 },
            },
          },
        ],
      },
      {
        heading: "Od statistike do odluke",
        blocks: [
          "Statistika zaslužuje prilagodbu kad joj cijeli interval leži s jedne strane crte koja nešto odlučuje. Foldovi na c-bet odlučuju isplati li se čisti blef određene veličine: blef od pola pota treba 33,3 % foldova. Igrač na 55 % ± 8 je iznad te crte; igrač na 40 % ± 14 nije, što god 40 % sugeriralo.",
          "Statistike koje dolaze u svakoj ruci smire se kroz nekoliko stotina ruku. Statistike kojima treba rjeđa situacija — fold na 3-bet, bilo što na riveru — traže mnogo sesija, a na jednom igraču možda se nikad ne smire. Odjeljak o poolu niže zbraja tvoje vlastite protivnike, i tu rjeđe statistike prvo postaju čitljive.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Broji prilike, ne ruke.",
        "Margina ≈ 1,96 × √(p(1 − p) / n); četiri puta više prilika za pola margine.",
        "Djeluj na statistiku kad joj cijeli interval prelazi crtu koja odlučuje.",
        "Rijetkim situacijama treba cijeli tvoj pool, ne jedan igrač.",
      ],
      breaks: [
        "Statistika iz druge igre ili drugog limita opisuje drugog igrača.",
        "Igrači se mijenjaju; velik star uzorak može sakriti nedavnu promjenu.",
      ],
    },
    exercises: {
      "margin-of-error": "Šest pitanja o veličini uzorka: koliko je širok interval statistike kroz njezine prilike ili koliko joj prilika treba.",
    },
    checks: [
      { fn: "marginOfError", args: [0.3, 50], value: 0.127 },
      { fn: "marginOfError", args: [0.3, 500], value: 0.04 },
      { fn: "sampleNeeded", args: [0.3, 0.05], value: 322.7 },
      { fn: "sampleNeeded", args: [0.3, 0.025], value: 1290.8 },
      { fn: "ratio", args: [1290.8, 322.7], value: 4 },
      { fn: "marginOfError", args: [0.1, 50], value: 0.083 },
      { fn: "alpha", args: [1, 0.5], value: 0.333 },
    ],
  },

  /* --------------------------------------------------------------- X2 pool */

  "population-exploits": {
    sections: [
      {
        heading: "Kreni od osnove",
        blocks: [
          "Railov solve je osnova: strategija koju nijedan protivnik ne može puno pobijediti. Exploit je promjena osnove protiv jedne konkretne pogreške, i odriče se dijela te sigurnosti. Bez procjene igraš osnovu: exploit laboratorij mjeri koliko ona gubi protiv protivnika koji je savršeno kontrira, a na riverima koje je Rail provjerio to je sitnica prema onome što riskira bilo koji exploit.",
          "Redoslijed je dakle zadan: prvo osnova, onda jedna promjena, ondje gdje su dokazi.",
        ],
      },
      {
        heading: "Tvoj pool, iz tvojih ruku",
        blocks: [
          "\"Pool\" znači igrače koje stvarno susrećeš. Rail nema brojke o tuđem poolu, a ovaj tečaj ih ne navodi: odjeljak niže zbraja tvoje protivnike iz panela protivnika, s prilikama iza svake statistike. Procjena poola ista je aritmetika kao procjena jednog igrača, kroz više prilika.",
          "Crta koja odlučuje je jednostavna: čisti blef od pola pota treba 33,3 % foldova, blef veličine pota 50 %. Ako foldovi tvog poola na c-bet leže cijeli iznad prve, blefovi od pola pota protiv njega zarađuju i prije nego što se išta drugo promijeni.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 10, bet: 5, share: 0.4 },
            caption: "Blef od pola pota. Postavi postotak foldova na broj svog poola i vidi što blef zarađuje.",
          },
        ],
      },
      {
        heading: "Prati promjenu kroz ruku",
        blocks: [
          "Jedna procjena mijenja više od jedne odluke. Kad laboratorij zaključa protivnika na riveru da više folda na betove, najbolji odgovor više blefira — i najjače ruke beta manje, jer se veliki betovi koji su prije bili plaćeni sad foldaju. Prilagodba koju napraviš na jednom mjestu i zaboraviš na sljedećem pola je prilagodbe.",
          {
            checkpoint: {
              question: "Protiv protivnika koji na svaku veličinu river beta folda više od solvea, što Railov najbolji odgovor radi sa svojim bojama i setovima?",
              options: ["Beta ih veće", "Beta ih manje", "Češće ih checka"],
              answer: 1,
              explain:
                "Dodatni foldovi dolaze na svakoj veličini, pa se i veliki bet s nutsom češće folda. Najbolji odgovor drži jake ruke u potu manjim betovima, a velike veličine koristi za blefove, kojima foldovi trebaju.",
            },
          },
          {
            note: {
              tone: "approximate",
              text: "Iz Railova exploit laboratorija: jedna sklonost zaključana na riveru riješenom na zahtjev, ostatak protivnikove strategije kakav je u solveu. Rasponi počivaju na Railovu modelu sužavanja.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Prvo osnova; promijeni jednu stvar, ondje gdje su dokazi.",
        "Procjena poola su tvoji vlastiti protivnici, s njihovim uzorkom.",
        "Prati prilagodbu do svake odluke koju dotiče.",
      ],
      breaks: [
        "Druga stranica, drugi limit ili drugo doba dana drugi su pool.",
        "Regular koji primijeti tvoju prilagodbu više nije pool.",
      ],
    },
    exercises: {
      "pool-reads": "Četiri rivera, svaki sa zaključanom procjenom protivnika: odigraj ono što igra Railov najbolji odgovor.",
      "your-hands": "Tvoje vlastite odluke na riveru, kad betaš prvi i kad dočekaš bet, najskuplje prve.",
    },
    checks: [
      { fn: "alpha", args: [1, 0.5], value: 0.333 },
      { fn: "alpha", args: [1, 1], value: 0.5 },
    ],
  },

  "exploiting-overfolders": {
    sections: [
      {
        heading: "Koliko vrijedi fold",
        blocks: [
          "Čisti blef od b u pot p igra na nulu kad protivnik folda u b / (p + b) slučajeva: trećina pota treba 25 %, pola pota 33,3 %, tri četvrtine 42,9 %, pot 50 %. Svaki bod iznad te crte je dobit. Blef veličine pota, 10 u 10, protiv igrača koji folda 60 %: 0,6 × 10 − 0,4 × 10 = 2 bb svaki put.",
          {
            widget: { id: "bet-math", focus: "alpha", pot: 10, bet: 10, share: 0.6 },
            caption: "Blef veličine pota protiv igrača koji folda 60 %. Spusti foldove na 50 % i dobiti više nema.",
          },
        ],
      },
      {
        heading: "Što Railov najbolji odgovor mijenja",
        blocks: [
          "Zaključaj protivnika na riveru da na svaku veličinu folda više od solvea, i najbolji odgovor laboratorija mijenja tri stvari odjednom. Blefira s gotovo svim rukama koje ne mogu dobiti na showdownu, i to velikim veličinama. Slabe parove i asa kao najvišu kartu, koje solve checka, također pretvara u blefove. A najjače ruke beta manje: foldovi dolaze na svakoj veličini, pa bi se i veliki bet s nutsom češće foldao.",
          {
            widget: { id: "exploit-lab", preset: "overfold" },
            caption: "Laboratorij sa zaključanim igračem koji previše folda. Pomakni procjenu i pokreni drugi river.",
          },
          {
            checkpoint: {
              question: "Protiv igrača koji previše folda, što Railov najbolji odgovor radi sa slabim parovima koje solve checka?",
              options: ["I dalje ih checka", "Mnoge beta kao blefove", "Beta ih malim betom zbog valuea"],
              answer: 1,
              explain:
                "Slab par na showdownu pobjeđuje samo zrak. Kad protivnik na bet folda većinu svojih ruku, par više zarađuje betom i uzimanjem pota nego showdownom, pa postaje blef.",
            },
          },
        ],
      },
      {
        heading: "Odakle dolaze foldovi i što to košta",
        blocks: [
          "Nitko ne folda previše posvuda. Tvoji podaci kažu gdje: panel protivnika broji foldove na c-bet na flopu, a odjeljak o poolu niže zbraja ih preko tvojih protivnika. Blefiraj više ondje gdje interval prelazi crtu, a ne posvuda.",
          "I izbroji rizik. Na većini rivera koje je laboratorij probao, previše blefova protiv igrača koji zapravo igra osnovu košta manje nego što dobiva protiv onoga koji previše folda; protiv igrača koji to primijeti i calla do kraja košta više nego što dobiva na gotovo svakom riveru. Što je prilagodba veća, to se više isplati biti u pravu.",
          {
            note: {
              tone: "approximate",
              text: "Iz Railova exploit laboratorija: procjena zaključana na riveru riješenom na zahtjev, ostatak protivnikove strategije kakav je u solveu. Rasponi počivaju na Railovu modelu sužavanja.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Blef od b u p treba b / (p + b) foldova; sve iznad je dobit.",
        "Protiv igrača koji folda blefiraj gotovo svakom rukom koja ne može dobiti na showdownu.",
        "Pretvori i slabe parove i asa kao najvišu kartu u blefove.",
        "Najjače ruke betaj manje: i veliki betovi se foldaju.",
      ],
      breaks: [
        "Igrač koji previše folda na male betove možda calla velike: provjeri što su tvoji podaci brojali.",
        "Čim počne callati, vrati se osnovi prije nego što te blefovi stanu.",
      ],
    },
    exercises: {
      "bluff-break-even": "Šest blefova za izračunati: koliko često protivnik mora foldati?",
      "overfold-lock": "Četiri rivera protiv protivnika zaključanog da folda više od solvea: odigraj ruku najboljeg odgovora.",
      "your-hands": "Tvoje vlastite prve odluke na riveru, najskuplje prve.",
    },
    checks: [
      { fn: "alpha", args: [3, 1], value: 0.25 },
      { fn: "alpha", args: [2, 1], value: 0.333 },
      { fn: "alpha", args: [4, 3], value: 0.429 },
      { fn: "alpha", args: [1, 1], value: 0.5 },
      { fn: "bluffEv", args: [10, 10, 0.6], value: 2 },
    ],
  },

  "exploiting-calling-stations": {
    sections: [
      {
        heading: "Value je cijela igra",
        blocks: [
          "Protiv igrača koji previše calla blefovi prestaju raditi, a value betovi rade bolje. Betaj 10 u 20 s rukom koja je ispred u 55 % slučajeva kad dobije call, protiv igrača koji calla 80 %: svaki call osvaja 0,55 × 10 − 0,45 × 10 = 1 bb više od checka, a 0,8 × 1 = 0,8 bb po betu. Isti igrač koji na blef veličine pota folda 25 % košta ga 0,25 × 10 − 0,75 × 10 = −5 bb svaki put.",
          {
            widget: { id: "value-bet", pot: 20, bet: 10, share: 0.55 },
            caption: "Bet od 10 bb u 20 bb, ispred u 55 % slučajeva kad dobije call. Spusti na 50 % i bet ništa ne zarađuje.",
          },
        ],
      },
      {
        heading: "Railov najbolji odgovor protiv stationa",
        blocks: [
          "Zaključaj protivnika na riveru da na svaku veličinu calla više od solvea, i najbolji odgovor laboratorija prestaje s gotovo svim blefovima: promašeni drawovi i ruke bez para checkaju. Najjače ruke prelaze na najveće veličine, jer callovi ionako dolaze. Neki srednji parovi koje solve checka počinju betati zbog valuea, dok as kao najviša karta, koji pobjeđuje malo toga što calla, checka još više.",
          {
            widget: { id: "exploit-lab", preset: "station" },
            caption: "Laboratorij sa zaključanim calling stationom.",
          },
          {
            checkpoint: {
              question: "Protiv igrača koji calla daleko više od solvea, koju veličinu Railov najbolji odgovor najčešće bira sa svojim najjačim rukama?",
              options: ["Trećinu pota", "Pot", "All-in"],
              answer: 2,
              explain:
                "Vrijednost jake ruke je ono što dobije call. Ako callovi dolaze bez obzira na veličinu, najveći bet skuplja najviše, pa najbolji odgovor beta nuts onoliko koliko stackovi dopuštaju.",
            },
          },
        ],
      },
      {
        heading: "Igrač koji nikad ne raisea",
        blocks: [
          "Tanki value koče raiseovi: svaki raise na koji moraš foldati stoji cijeli bet ([[expected-value|očekivana vrijednost]] to broji). Zaključaj protivnika na riveru da nikad ne raisea, i najbolji odgovor laboratorija beta daleko više svojih top parova i srednjih parova: bez raisea kojeg se treba bojati, isplati se bet koji dobiva nešto više od pola puta kad dobije call. Lekcija o tankom valueu (R1-L2) ima aritmetiku.",
          {
            note: {
              tone: "approximate",
              text: "Iz Railova exploit laboratorija: procjena zaključana na riveru riješenom na zahtjev, ostatak protivnikove strategije kakav je u solveu. Rasponi počivaju na Railovu modelu sužavanja.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Protiv stationa prestani blefirati.",
        "Jake ruke betaj onoliko veliko koliko callovi dopuštaju.",
        "Betaj tanje zbog valuea, pogotovo kad nikad ne raisea.",
        "Asa kao najvišu kartu checkaj: pobjeđuje malo toga što calla.",
      ],
      breaks: [
        "Station koji folda na velike betove ondje nije station: provjeri njegove foldove po veličini.",
        "Igrač koji široko calla flop i turn možda ipak folda river: nađi na kojoj ulici calla.",
      ],
    },
    exercises: {
      "station-lock": "Četiri rivera protiv protivnika zaključanog da calla više od solvea: odigraj ruku najboljeg odgovora.",
      "passive-lock": "Tri rivera protiv protivnika koji nikad ne raisea: odigraj ruku najboljeg odgovora.",
      "value-rivers": "Četiri rivera u poziciji nakon checka, ocijenjena Railovim rješenjem rivera: osnova, prije prilagodbe.",
      "your-hands": "Tvoje vlastite prve odluke na riveru i ruke označene zbog checkanja vrlo jake ruke.",
    },
    checks: [
      { fn: "product", args: [0.55, 10], value: 5.5 },
      { fn: "product", args: [0.45, 10], value: 4.5 },
      { fn: "sum", args: [5.5, -4.5], value: 1 },
      { fn: "product", args: [0.8, 1], value: 0.8 },
      { fn: "bluffEv", args: [10, 10, 0.25], value: -5 },
    ],
  },

  "exploiting-aggressive-players": {
    sections: [
      {
        heading: "Cijena bluff-catcha",
        blocks: [
          "Pred river betom veličine pota, 20 u 20, callaš 20 da osvojiš 40: bluff-catcheru treba da trećina betova budu blefovi. Protiv igrača čiji su betovi pola blefovi svaki call vrijedi 0,5 × 40 − 0,5 × 20 = 10 bb. Agresija koja trči ispred ruku iza sebe plaća igrače koji je callaju.",
          {
            widget: { id: "bluff-catcher", pot: 20, bet: 20, share: 0.5 },
            caption: "Bet veličine pota koji je pola blefovi. Spusti blefove na trećinu i call se prestaje isplaćivati.",
          },
        ],
      },
      {
        heading: "Railov najbolji odgovor protiv igrača koji previše blefira",
        blocks: [
          "Zaključaj protivnika koji na riveru djeluje prvi da beta mnogo više svog zraka, i najbolji odgovor laboratorija calla daleko više sa srednjim parovima, slabim parovima i asom kao najvišom kartom: rukama koje pobjeđuju blef i ništa drugo. Dio svog zraka također raisea kao blef. Dodatni betovi su zrak, a zrak ne može callati raise — dok god ih protivnik folda, što je dio procjene.",
          {
            widget: { id: "exploit-lab", preset: "maniac" },
            caption: "Laboratorij sa zaključanim igračem koji previše blefira.",
          },
          {
            checkpoint: {
              question: "Protiv protivnika koji na riveru beta većinu svog zraka, koje tvoje ruke u Railovu najboljem odgovoru dobivaju najviše callova?",
              options: ["Boje", "Srednji i slabi parovi", "Fullovi"],
              answer: 1,
              explain:
                "Boje i fullovi callaju ili raiseaju protiv gotovo svakog igrača koji beta. Mijenja se odgovor ruku koje pobjeđuju samo blefove: s više blefova u rasponu betova srednji i slabi parovi postaju call.",
            },
          },
        ],
      },
      {
        heading: "Agresija nije isto što i blefiranje",
        blocks: [
          "Panel protivnika broji betove i raiseove; ne može razlikovati blef od jake ruke odigrane brzo. Igrač koji puno beta možda jednostavno puno i drži. Procjena koja vrijedi je ono što pokaže na showdownu nakon betanja — tvoje ruke u kojima si callao i vidio karte — a taj uzorak raste sporo.",
          "Turn radi isto, uz jedan oprez: Rail rješava turn s jednom veličinom beta, pa turn vježbe ovdje vježbaju callanje barrela protiv Railove osnove, a ne protiv zaključanog protivnika.",
          {
            note: {
              tone: "approximate",
              text: "Laboratorij zaključava samo river. Turn situacije rješavaju se s jednom veličinom beta (75 % pota) i all-inom, na rasponima suženim Railovim heurističkim modelom.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Bluff-catcheru trebaju blefovi po cijeni beta: trećina beta veličine pota.",
        "Protiv igrača koji previše blefira callaj šire s parovima i asom kao najvišom kartom.",
        "Raiseaj dio zraka kad su njegovi dodatni betovi zrak koji folda.",
        "Agresiju sudi po onome što pokaže na showdownu, ne po tome koliko često beta.",
      ],
      breaks: [
        "Igrač koji puno beta jer puno drži ne blefira: provjeri njegove showdowne.",
        "Protiv igrača koji nikad ne folda na raise, raise zrakom čisti je gubitak.",
      ],
    },
    exercises: {
      "aggro-lock": "Četiri rivera protiv protivnika zaključanog da beta većinu svog zraka: odigraj ruku najboljeg odgovora.",
      "catch-barrels": "Tri turna u poziciji pred betom, ocijenjena Railovim rješenjem turna: osnova.",
      "your-hands": "Tvoje vlastite odluke na turnu i riveru pred betom, i foldovi označeni jer je cijena bila za call.",
    },
    checks: [
      { fn: "requiredEquity", args: [40, 20], value: 0.333 },
      { fn: "bluffCatcherEv", args: [20, 20, 0.5], value: 10 },
    ],
  },

  "underbluffed-rivers": {
    sections: [
      {
        heading: "Koliko blefova bet treba",
        blocks: [
          "River bet mora nositi dovoljno blefova da bluff-catcher callom igra na nulu: trećinu betova za bet veličine pota, četvrtinu za bet od pola pota. Kad igrač koji beta nosi manje, svaki bluff-catcher gubi callom. Pred betom veličine pota, 20 u 20, od igrača čiji su betovi samo 20 % blefovi: 0,2 × 40 − 0,8 × 20 = −8 bb po callu.",
          {
            widget: { id: "bluff-catcher", pot: 20, bet: 20, share: 0.2 },
            caption: "Bet veličine pota s premalo blefova. Nađi udio blefova na kojem call igra na nulu.",
          },
        ],
      },
      {
        heading: "Railov najbolji odgovor: foldaj više",
        blocks: [
          "Zaključaj protivnika na riveru da beta gotovo nimalo svog zraka, i najbolji odgovor laboratorija folda daleko više svojih bluff-catchera. Srednji i slabi parovi foldaju najčešće od svih, a i top parovi i dva para foldaju više nego što ih folda solve. Najjače ruke i dalje callaju i raiseaju: pobjeđuju i value betove.",
          {
            widget: { id: "exploit-lab", preset: "underbluff" },
            caption: "Laboratorij sa zaključanim igračem koji rijetko blefira.",
          },
          {
            checkpoint: {
              question: "Protiv protivnika koji beta gotovo nimalo svog zraka, što se u Railovu najboljem odgovoru događa s top parom pred njegovim river betom?",
              options: ["Češće calla", "Češće folda", "Češće raisea"],
              answer: 1,
              explain:
                "Top par pobjeđuje blefove i dio tankog valuea. Kad blefova nema, ono što ostane u rasponu betova pobjeđuje ga češće nego što cijena dopušta, pa ga najbolji odgovor češće folda.",
            },
          },
        ],
      },
      {
        heading: "Gdje su dokazi",
        blocks: [
          "Panel protivnika ne vidi river blef: broji betove te koliko često igrač dolazi do showdowna i ondje dobiva, što nagovješćuje što pokazuje, ali blefove ne broji. Izravni dokaz su tvoje ruke u kojima si callao river bet i vidio karte. Takvih je nekoliko po sesiji, pa procjena na jednom igraču rijetko prijeđe svoj interval; preko cijelog tvog poola jedna linija može.",
          "Foldaj više ondje gdje dokazi to kažu, i nastavi callati gdje linija još nosi dovoljno blefova: foldaj sve i postaješ igrač koji previše folda iz lekcije X2-L2.",
          {
            note: {
              tone: "approximate",
              text: "Iz Railova exploit laboratorija: procjena zaključana na riveru riješenom na zahtjev, ostatak protivnikove strategije kakav je u solveu. Rasponi počivaju na Railovu modelu sužavanja.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Bet veličine pota treba trećinu blefova, bet od pola pota četvrtinu.",
        "Protiv igrača koji rijetko blefira foldaj više svojih parova.",
        "River procjenu sudi po onome što si vidio callajući, s uzorkom.",
      ],
      breaks: [
        "Igrač koji nikad ne blefira jednu liniju možda blefira drugu: čitaj svaku liniju zasebno.",
        "Foldaj sve i pozivaš blefove natrag.",
      ],
    },
    exercises: {
      "underbluff-lock": "Četiri rivera protiv protivnika zaključanog da beta gotovo nimalo zraka: odigraj ruku najboljeg odgovora.",
      "river-calls": "Četiri rivera u poziciji pred betom, ocijenjena Railovim rješenjem rivera: osnova.",
      "your-hands": "Tvoje vlastite odluke na riveru pred betom i callovi označeni jer ništa ne pobjeđuju.",
    },
    checks: [
      { fn: "bluffShare", args: [20, 20], value: 0.333 },
      { fn: "bluffShare", args: [20, 10], value: 0.25 },
      { fn: "bluffCatcherEv", args: [20, 20, 0.2], value: -8 },
    ],
  },

  /* ---------------------------------------------------------- X3 exploit laboratorij */

  "node-locking-in-rail": {
    sections: [
      {
        heading: "Što je zaključavanje",
        blocks: [
          "Railovo rješenje rivera je osnova: oba igrača igraju najbolje što solve može. Zaključavanje fiksira jednu protivnikovu odluku na broj koji odabereš — koliko više ili manje folda na tvoje river betove, da nikad ne raisea, koliko svog zraka beta kad djeluje prvi — a sve ostalo što radi ostavlja kakvo je u solveu. Rail tada računa tvoj najbolji odgovor: strategiju koja protiv točno tog protivnika zarađuje najviše.",
          "Zamrznuti ostatak pošten je model procjene: \"Mislim da radi ovo, a ništa se drugo ne mijenja\". To je i granica laboratorija. Pravi igrač koji previše folda možda i blefira drugačije; laboratorij mu to ne izmišlja.",
        ],
      },
      {
        heading: "Tri broja, na igri koju možeš provjeriti ručno",
        blocks: [
          "Uzmi Railovu najmanju testnu igru: pot od 10, bet od 10, igrač koji beta drži nuts ili ništa, svako u pola slučajeva, i caller s jednim bluff-catcherom. U osnovi caller calla pola puta, a igrač koji beta blefira pola svog zraka, što mu vrijedi 7,5. Zaključaj callera da folda 75 %.",
          {
            list: [
              "Blef sada zarađuje 0,75 × 10 − 0,25 × 10 = 5, pa najbolji odgovor blefira svim zrakom: 0,5 × 12,5 + 0,5 × 5 = 8,75.",
              "Osnova protiv istog callera zarađuje 6,25 + 0,25 × 5 = 7,5, pa procjena dobiva 8,75 − 7,5 = 1,25.",
              "Ako caller zapravo igra osnovu, blef zarađuje točno ništa, a odgovor i dalje donosi 7,5: bez troška.",
              "Ako caller to vidi i calla sve: 0,5 × 20 + 0,5 × −10 = 5, trošak 7,5 − 5 = 2,5 — dvostruko više od dobitka.",
            ],
          },
          "Railov laboratorij na ovoj igri vraća upravo ove brojeve; testovi to provjeravaju.",
          {
            checkpoint: {
              question: "U toj igri, koliko odgovor koji blefira svim zrakom gubi protiv callera koji zapravo igra osnovu?",
              options: ["Ništa", "1,25", "2,5"],
              answer: 0,
              explain:
                "Caller u osnovi calla točno toliko često da blef igra na nulu. Protiv njega svaki blef zarađuje nula, pa blefiranje svim zrakom ništa ne stoji. Trošak se pojavljuje tek kad se prilagodi — protiv callera koji calla sve.",
            },
          },
        ],
      },
      {
        heading: "Čitanje laboratorija na riveru",
        blocks: [
          "Na pravom riveru laboratorij pokazuje ista tri broja u bb po riveru, plus trošak same osnove protiv kontriranja, koji je malen. Ispod njih su odluke koje odgovor najviše mijenja, kategoriju po kategoriju ruku: što igra solve, a što odgovor. Odaberi procjenu, postavi njezin broj i pokreni.",
          {
            widget: { id: "exploit-lab", preset: "overfold" },
            caption: "Railov exploit laboratorij: river riješen u tvom pregledniku, jedna procjena zaključana, najbolji odgovor.",
          },
          {
            note: {
              tone: "approximate",
              text: "Laboratorij radi na riveru: situacija podijeljena iz chartova, rasponi suženi na flopu i turnu Railovim heurističkim modelom, betovi od 33 %, 75 % i 150 % pota i all-in.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Zaključavanje je procjena: jedna odluka fiksirana, sve ostalo kakvo je u solveu.",
        "Čitaj tri broja: dobitak, trošak ako griješiš, trošak ako te kontriraju.",
        "Trošak same osnove protiv kontriranja je pod s kojim uspoređuješ.",
      ],
      breaks: [
        "Igrač rijetko odstupa samo na jednom mjestu: laboratorij pokazuje jednu procjenu odjednom.",
        "Laboratorij pokriva river; ranije ulice pripadaju osnovi.",
      ],
    },
    exercises: {
      "lock-a-node": "Šest rivera, svaki sa zaključanom procjenom: odigraj ruku kako je protiv nje igra Railov najbolji odgovor.",
    },
    checks: [
      { fn: "product", args: [0.75, 10], value: 7.5 },
      { fn: "product", args: [0.25, 10], value: 2.5 },
      { fn: "sum", args: [7.5, -2.5], value: 5 },
      { fn: "product", args: [0.25, 10], value: 2.5 },
      { fn: "sum", args: [10, 2.5], value: 12.5 },
      { fn: "product", args: [0.5, 12.5], value: 6.25 },
      { fn: "product", args: [0.5, 5], value: 2.5 },
      { fn: "sum", args: [6.25, 2.5], value: 8.75 },
      { fn: "product", args: [0.25, 5], value: 1.25 },
      { fn: "sum", args: [6.25, 1.25], value: 7.5 },
      { fn: "sum", args: [8.75, -7.5], value: 1.25 },
      { fn: "product", args: [0.5, 20], value: 10 },
      { fn: "product", args: [0.5, -10], value: -5 },
      { fn: "sum", args: [10, -5], value: 5 },
      { fn: "sum", args: [7.5, -5], value: 2.5 },
    ],
  },

  "when-not-to-exploit": {
    sections: [
      {
        heading: "Premalo prilika",
        blocks: [
          "Exploit je oklada na procjenu, a procjena na deset prilika uglavnom je šum. Prije svake prilagodbe stavi interval na statistiku i pitaj leži li cijeli s jedne strane crte koja odlučuje.",
          {
            widget: { id: "sample-size", share: 0.7, count: 10 },
            caption: "Sedam foldova u deset prilika. Dodaj prilike dok interval ne prijeđe 33 %, foldove koje treba blef od pola pota.",
          },
          {
            checkpoint: {
              question: "Protivnik je foldao na 7 od 10 c-betova na koje je naišao. Je li to procjena za snažan exploit?",
              options: ["Da: 70 % je daleko iznad onoga što blef treba", "Još ne: interval seže oko 28 bodova na svaku stranu"],
              answer: 1,
              explain: "1,96 × √(0,7 × 0,3 / 10) je oko 0,28. Uz deset prilika odgovara bilo što od oko 42 % do 98 %; procjena je možda točna, ali deset prilika to ne može pokazati.",
              math: { fn: "marginOfError", args: [0.7, 10], value: 0.284 },
            },
          },
        ],
      },
      {
        heading: "Kontriranje stoji više od dobitka",
        blocks: [
          "U ručno izračunatoj igri laboratorija (lekcija X3-L1) procjena dobiva 1,25, a caller koji primijeti i prilagodi se uzima natrag 2,5. Na pravim riverima laboratorij nalazi isti oblik na gotovo svakom riveru koji je probao: ono što exploit gubi protiv kontriranja veće je od onoga što dobiva, dok je gubitak same osnove protiv njezina kontriranja malen.",
          "Exploit se dakle isplati samo ako protivnik vjerojatno neće prilagoditi igru prije nego što se exploit isplati. S tim brojevima, ako je vjerojatnost da kontrira a, procjena vrijedi (1 − a) × 1,25 − a × 2,5, što igra na nulu kod a = 1,25 / (1,25 + 2,5), jedne trećine. Protiv regulara koji te gleda trećina nije puno.",
        ],
      },
      {
        heading: "Kad je procjena kriva",
        blocks: [
          "Drugi rizik je procjena koja nikad nije bila točna. U igri-igrački kriva procjena ne stoji ništa, jer je caller u osnovi točno ravnodušan. Na pravim riverima najbolji odgovor laboratorija protiv protivnika koji igra osnovu obično gubi manje nego što dobiva protiv zaključanog — ali rijetko ništa, i više što je zaključavanje dalje od solvea.",
          "Vrati se osnovi kad je uzorak tanak, kad se igrač prilagođava ili kad bi kriva procjena puno stajala. Slobodno exploitaj igrače koji se ne prilagođavaju, na procjenama koje podržavaju tvoji vlastiti brojevi.",
          {
            note: {
              tone: "approximate",
              text: "Iz Railova exploit laboratorija: procjena zaključana na riveru riješenom na zahtjev, ostatak protivnikove strategije kakav je u solveu; kontriranje je protivnikov najbolji odgovor na tvoj exploit. Rasponi počivaju na Railovu modelu sužavanja.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Nema intervala preko crte, nema exploita.",
        "Očekuj da kontriranje stoji više nego što exploit dobiva.",
        "Najjače exploitaj igrače koji se ne prilagođavaju.",
        "Kad si u nedoumici, osnova.",
      ],
      breaks: [
        "Protiv igrača koji se nikad ne prilagođava kontriranje ne dolazi: osloni se na dobru procjenu.",
        "Neke prilagodbe gotovo ništa ne stoje ako su krive: njima treba manje sigurnosti.",
      ],
    },
    exercises: {
      "sample-size": "Pet pitanja o veličini uzorka: je li interval statistike dovoljno uzak da se na njemu djeluje?",
      "exploit-or-not": "Četiri rivera sa zaključanom procjenom: odigraj najbolji odgovor, pa pročitaj što riskira.",
    },
    checks: [
      { fn: "sum", args: [1.25, 2.5], value: 3.75 },
      { fn: "ratio", args: [1.25, 3.75], value: 0.333 },
    ],
  },

  /* ----------------------------------------------------------- X4 uživo i duboko */

  "live-game-dynamics": {
    sections: [
      {
        heading: "Veća otvaranja",
        blocks: [
          "Igre uživo otvaraju veće nego online. Otvaranje na 5 bb u blindove od 1,5 bb riskira 5 da osvoji 1,5: samo za sebe treba da svi foldaju 5 / 6,5 = 76,9 % vremena, dok online otvaranje od 2,5 bb treba 2,5 / 4 = 62,5 %. Veće otvaranje mora češće dobiti bez borbe ili više dobiti nakon flopa.",
          {
            widget: { id: "bet-math", focus: "steal", pot: 1.5, bet: 5, share: 0.77 },
            caption: "Otvaranje na 5 bb u 1,5 bb blindova. Postavi ga na 2,5 bb i usporedi.",
          },
          {
            checkpoint: {
              question: "Koliko često svi moraju foldati da otvaranje na 5 bb u 1,5 bb blindova samo za sebe igra na nulu?",
              options: ["62,5 %", "76,9 %", "50 %"],
              answer: 1,
              explain: "Rizik kroz rizik plus nagradu: 5 / (5 + 1,5) je oko 76,9 %.",
              math: { fn: "ratio", args: [5, 6.5], value: 0.769 },
            },
          },
        ],
      },
      {
        heading: "Duboki, neujednačeni stackovi",
        blocks: [
          "Stackovi uživo često su duboki i neujednačeni. Otvaranje na 5 bb koje big blind calla sa stackovima od 200 bb daje pot od 5 + 5 + 0,5 = 10,5 sa 195 iza: SPR od 18,57. Online otvaranje od 2,5 bb callano na 100 bb daje 5,5 s 97,5 iza, 17,73. Veće otvaranje drži SPR otprilike ondje kamo bi ga gurnuli dublji stackovi; uvijek ga broji prema kraćem od dva stacka u ruci.",
          {
            widget: { id: "spr", pot: 10.5, stack: 195 },
            caption: "Pot uživo: otvaranje na 5 bb callano, 200 bb duboko.",
          },
        ],
      },
      {
        heading: "Tempo, rake, pot i pokazivanje blefa",
        blocks: [
          "Uživo se dijeli daleko manje ruku na sat, pa svakoj statistici treba dulje da nešto znači: statistici blizu 30 % treba oko 323 prilike za ± 5 bodova (lekcija X1-L2), a uživo je to mnogo sesija. Rake određuje kuća; Railovi chartovi pretpostavljaju vlastiti profil rakea, pa bitno drugačiji rake pomiče najtanja otvaranja i obrane. Broji pot u žetonima ulicu po ulicu: svaka cijena u ovom tečaju kreće od njega.",
          "Pokazivanje blefa exploit je kratkog vijeka: pažljivim igračima kaže nešto istinito o tebi i oni se prilagode. Protiv igrača koji ne gledaju ništa ne mijenja.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Otvaranje uživo cijeni kao rizik kroz rizik plus blindove.",
        "SPR broji prema kraćem stacku u ruci.",
        "Uzorci uživo traju sesijama: dulje vjeruj osnovi.",
        "Prati pot u žetonima na svakoj ulici.",
      ],
      breaks: [
        "Stol koji calla svako otvaranje fold equity čini nevažnim: otvaraj zbog valuea.",
        "Igrači koji nikad ne gledaju showdowne ignoriraju ono što pokažeš.",
      ],
    },
    exercises: {
      "live-spr": "Pet SPR-ova za izračunati iz pota i stackova iza.",
      "live-steal": "Pet otvaranja za izračunati: koliko često svi moraju foldati?",
      "pot-tracking": "Planirano: ruka u stilu igre uživo u kojoj pratiš pot.",
    },
    checks: [
      { fn: "ratio", args: [2.5, 4], value: 0.625 },
      { fn: "sum", args: [5, 5, 0.5], value: 10.5 },
      { fn: "spr", args: [195, 10.5], value: 18.57 },
      { fn: "spr", args: [97.5, 5.5], value: 17.73 },
      { fn: "sampleNeeded", args: [0.3, 0.05], value: 322.7 },
    ],
  },

  "straddle-preflop": {
    sections: [
      {
        heading: "Što straddle mijenja",
        blocks: [
          "Straddle je dobrovoljni blind od 2 bb postavljen prije karata, obično under the gun. Pot počinje od 0,5 + 1 + 2 = 3,5 bb, straddler djeluje zadnji prije flopa, a svaki stack vrijedi upola manje novih big blindova: 100 bb je 50 straddleova. Igra se igra kao plića, s više mrtvog novca u sredini.",
          {
            checkpoint: {
              question: "Uz straddle under the gun, tko djeluje zadnji prije flopa?",
              options: ["Big blind", "Straddler", "Button"],
              answer: 1,
              explain: "Straddle je najveći blind, pa akcija završava na njemu: straddler djeluje nakon big blinda, kao vlastiti big blind.",
            },
          },
        ],
      },
      {
        heading: "Otvaranje u straddle",
        blocks: [
          "Otvaranja rastu sa straddleom. Otvaranje na 6 bb riskira 6 da osvoji 3,5 u sredini i samo za sebe treba da svi foldaju 6 / 9,5 = 63,2 % — otprilike koliko 2,5 bb u 1,5 bb treba bez straddlea. Pozicije se pomiču za jednu: prvo mjesto koje otvara je ono nakon straddlera.",
          {
            widget: { id: "bet-math", focus: "steal", pot: 3.5, bet: 6, share: 0.63 },
            caption: "Otvaranje na 6 bb u pot sa straddleom od 3,5 bb.",
          },
        ],
      },
      {
        heading: "Obrana straddlea i blindovi",
        blocks: [
          "Straddler pred otvaranjem na 6 bb, kad su svi ostali foldali, calla 4 da osvoji pot od 9,5: call treba 4 / 13,5 = 29,6 % pota nakon njega. Brani kao big blind, s pozicijom na blindove, ali s manje straddleova iza. Small blind je bez pozicije protiv svih i igra tighter; u igrama sa straddleom ima i više callera, pa je više potova multiway.",
          {
            note: {
              tone: "conceptual",
              text: "Rail nema chartove za straddle, pa se rasponi sa straddleom uče riječima. Setovi chartova na plićim dubinama najbliže su što Rail ima, ali nisu igre sa straddleom.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Broji stackove u straddleovima: 100 bb je 50.",
        "Povećaj otvaranja sa straddleom i cijeni ih na isti način.",
        "Brani straddle kao big blind s manje iza.",
      ],
      breaks: [
        "Stol na kojem svi callaju otvaranja multiway je igra: value ispred krađa.",
        "Straddle na buttonu opet mijenja tko djeluje zadnji: pozicije broji iznova.",
      ],
    },
    exercises: {
      "straddle-steal": "Šest otvaranja u blindove i straddleove: koliko često svi moraju foldati?",
      "straddle-price": "Pet callova za izračunati protiv beta: koliko im equityja treba?",
      "straddle-charts": "Planirano: oboji raspon mjesta sa straddleom kad Rail dobije chartove za straddle.",
    },
    checks: [
      { fn: "sum", args: [0.5, 1, 2], value: 3.5 },
      { fn: "ratio", args: [100, 2], value: 50 },
      { fn: "ratio", args: [6, 9.5], value: 0.632 },
      { fn: "requiredEquity", args: [9.5, 4], value: 0.296 },
    ],
  },

  "straddle-postflop-low-spr": {
    sections: [
      {
        heading: "Potovi narastu prije flopa",
        blocks: [
          "Pot sa straddleom velik je i prije nego što flop počne. Otvaranje na 6 bb koje callaju straddler i još jedan igrač stavlja 6 × 3 + 0,5 + 1 = 19,5 bb u sredinu s 94 bb iza: SPR od 4,82. To je SPR 3-bet pota, dobiven bez 3-beta.",
          {
            widget: { id: "spr", pot: 19.5, stack: 94 },
            caption: "Flop sa straddleom: 19,5 bb u potu, 94 bb iza.",
          },
        ],
      },
      {
        heading: "Predanost uz nizak SPR",
        blocks: [
          "Uz SPR blizu 5 tri beta od oko 60 % pota stavljaju stackove unutra do rivera; dvije ulice traže betove od oko 113 %. Top par s dobrim kickerom ili overpar planira uložiti novac, jer kasniji fold baca pot koji je izgradio. [[equity-realisation-and-implied-odds|Implicirani izgledi]] se smanjuju: s tako malo iza draw kad pogodi dobiva malo više od onoga što pot već nudi.",
          {
            checkpoint: {
              question: "Pot sa straddleom, SPR blizu 5, top par s dobrim kickerom na suhom flopu. Koji je plan?",
              options: ["Uložiti stackove kroz ulice", "Checkati i foldati na raise", "Betati jednom pa odustati"],
              answer: 0,
              explain: "Betovi od oko 60 % pota na svakoj ulici stavljaju stackove unutra do rivera. Ruka ove jačine uz ovaj SPR dobiva prečesto da bi se foldala kad je novac u sredini.",
            },
          },
        ],
      },
      {
        heading: "Drawovi i više igrača",
        blocks: [
          "Više callera prije flopa znači više multiway flopova. Blef u dva igrača koji svaki folda pola puta uspijeva u 0,5 × 0,5 = 25 % slučajeva, a bet u dvojicu moraju braniti obojica: lekcije o multiway igri (F5) to cijene. River vježbe ovdje koriste 3-bet potove, najbliži SPR koji Rail rješava.",
          {
            note: {
              tone: "approximate",
              text: "Rail ne analizira potove sa straddleom. Vježbe dijele rivere iz 3-bet potova, čiji je SPR blizu; rasponi dolaze iz chartova, suženi Railovim heurističkim modelom.",
            },
          },
        ],
      },
    ],
    heuristics: {
      rules: [
        "Broji SPR na svakom flopu sa straddleom; često je SPR 3-bet pota.",
        "Uz SPR blizu 5 top par i overparovi planiraju uložiti stackove.",
        "Drawovi gube implicirane izglede kad je malo iza.",
      ],
      breaks: [
        "Duboke igre sa straddleom drže viši SPR: broji, nemoj pretpostavljati.",
        "Multiway je top par slabiji: u dva igrača se predaj manje spremno.",
      ],
    },
    exercises: {
      "low-spr": "Šest SPR-ova za izračunati iz pota i stackova iza.",
      "low-spr-rivers": "Tri rivera iz 3-bet potova, najbliži SPR koji Rail rješava, ocijenjena Railovim rješenjem rivera.",
    },
    checks: [
      { fn: "sum", args: [18, 0.5, 1], value: 19.5 },
      { fn: "spr", args: [94, 19.5], value: 4.82 },
      { fn: "geometricBet", args: [19.5, 94, 3], value: 0.6 },
      { fn: "geometricBet", args: [19.5, 94, 2], value: 1.13 },
      { fn: "allFold", args: [0.5, 2], value: 0.25 },
    ],
  },

  "deep-stacks-200bb": {
    sections: [
      {
        heading: "Što duboki stackovi nagrađuju",
        blocks: [
          "Na 200 bb pot s jednim raiseom počinje duboko: otvaranje na 2,5 bb koje big blind calla ostavlja 197,5 bb iza pota od 5,5, SPR od 35,9, oko dvostruko više od 17,7 na 100 bb. S toliko iza, ruke koje mogu napraviti nuts dobivaju velike potove, a jedan par male: top par koji je dobar na 100 bb na 200 je često ruka s kojom pot držiš malim.",
          {
            widget: { id: "spr", pot: 5.5, stack: 197.5 },
            caption: "Pot s jednim raiseom na 200 bb. Prepolovi stack i usporedi.",
          },
        ],
      },
      {
        heading: "Railovi chartovi za 200 bb",
        blocks: [
          "Railovi chartovi na 200 bb, riješeni kao set za 100 bb s dubljim stackovima, s ranih mjesta otvaraju više ruku, a dobitak je koncentriran: daleko više suited asova i nešto više suited konektora, dok se offsuit broadway ruke jedva mijenjaju. S buttona se raspon otvaranja jedva pomiče, a obrana big blinda protiv otvaranja s buttona gotovo je ista. Chart kvizovi niže dijele iz tog seta.",
          {
            checkpoint: {
              question: "Koje ruke u Railovim chartovima under the gun otvara mnogo češće na 200 bb nego na 100 bb?",
              options: ["Offsuit broadway ruke", "Suited asove", "Offsuit asove"],
              answer: 1,
              explain:
                "Suited as može napraviti nut boju, a duboki stackovi plaćaju nuts. Offsuit broadwayi uglavnom naprave jedan par, koji duboki stackovi ne plaćaju više, pa ih Railovi chartovi ostavljaju otprilike gdje su bili.",
            },
          },
        ],
      },
      {
        heading: "Veći betovi da stackovi uđu",
        blocks: [
          "Tri jednaka beta koja kroz flop, turn i river iz pota od 5,5 unose 197,5 bb moraju svaki biti oko 159 % pota; na 100 bb oko 116 %. Duboko, ili betovi rastu ili stackovi ne ulaze: planovi s nutsom počinju ranije i rastu, a ruke s jednim parom staju kod pota koji mogu podnijeti.",
        ],
      },
    ],
    heuristics: {
      rules: [
        "Broji SPR: potovi s jednim raiseom na 200 bb oko dvostruko su dublji.",
        "Duboki stackovi plaćaju ruke koje rade nuts.",
        "S jednim parom duboko drži pot malim.",
        "S nutsom rano povećaj betove ako želiš stackove unutra.",
      ],
      breaks: [
        "Računa se samo efektivni stack: kratki stack za stolom igra na svojoj dubini.",
        "Protiv igrača koji isplaćuju jedan par value betovi postaju deblji i duboko.",
      ],
    },
    exercises: {
      "deep-opens": "Dvanaest situacija za prvo otvaranje iz Railovih chartova za 200 bb, ocijenjenih kao što ih ocjenjuje analiza.",
      "deep-defence": "Dvanaest situacija pred otvaranjem, iz Railovih chartova za 200 bb.",
      "spr-toggle": "Planirano: razvrstaj isti raspon na flopu na 200 bb i na 100 bb, kad Railova flop biblioteka pokrije 200 bb.",
    },
    checks: [
      { fn: "spr", args: [197.5, 5.5], value: 35.9 },
      { fn: "spr", args: [97.5, 5.5], value: 17.7 },
      { fn: "geometricBet", args: [5.5, 197.5, 3], value: 1.59 },
      { fn: "geometricBet", args: [5.5, 97.5, 3], value: 1.16 },
    ],
  },
};

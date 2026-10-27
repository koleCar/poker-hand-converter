import type { ConceptTexts } from "./types";

/**
 * Preflop, Croatian. Same shape as preflop.en.ts: the same keys, paragraphs,
 * steps and formulas, with every number identical to the English one (written
 * with a decimal comma and a space before %).
 */
export const preflopHr: ConceptTexts<"rfi" | "three-bet" | "squeeze" | "blind-defence" | "steal"> = {
  rfi: {
    summary: "Raise first in: otvaranje pota raiseom kad su svi prije tebe foldali.",
    definition: [
      "RFI (raise first in) znači da je prva dobrovoljna akcija u ruci raise — open. Tvoj RFI postotak pokazuje koliko često otvaraš kad svi foldaju do tebe, a trebao bi uvelike ovisiti o tvojem sjedalu.",
      "Alternativa, call big blinda kao prvi u potu (open limp), u igri za šest igrača s rakeom rijetko je bolja: odričeš se prilike da odmah osvojiš blindove i pozivaš igrače iza sebe da raiseaju.",
    ],
    why: [
      "Rasponi za otvaranje šire se sa svakim sjedalom bliže buttonu: iza tebe ostaje manje igrača koji tek trebaju odigrati, a veća je vjerojatnost da ćeš nakon flopa imati poziciju.",
      "Iz under the guna pet igrača još može dobiti jaku ruku; s buttona samo dvojica — i obojica će biti izvan pozicije.",
      "Razumna veličina opena je 2 do 2,5 bb s većine sjedala, a nešto više iz small blinda, koji ostatak ruke igra izvan pozicije.",
    ],
    formulas: [
      {
        name: "RFI",
        expression: { frac: ["otvorene ruke", "ruke u kojima su svi foldali do tebe"] },
        spoken: "RFI je broj otvorenih ruku podijeljen s brojem ruku u kojima su svi foldali do tebe.",
      },
    ],
    example: {
      title: "Brojanje raspona iz under the guna",
      setup: "Ilustrativni raspon za under the gun koji koristimo na ovim stranicama: 66+, A9s+, A5s, A4s, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo.",
      steps: [
        "Parovi od 66 do AA: 9 parova × 6 = 54 kombinacije.",
        "Suited ruke: A9s do AKs (5), A5s i A4s (2), KTs do KQs (3), QTs i QJs (2), JTs, T9s i 98s (3) — 15 klasa × 4 = 60 kombinacija.",
        "Offsuit ruke: AJo, AQo, AKo i KQo — 4 klase × 12 = 48 kombinacija.",
        "Ukupno: 54 + 60 + 48 = 162 kombinacije, 162 / 1.326 ≈ 12,2 % svih ruku.",
      ],
      takeaway: "Ilustrativni raspon buttona na ovim stranicama je oko 42 % — više nego triput više ruku, od istog igrača, a razlog je sjedalo.",
    },
    mistakes: [
      "Otvaranje istog raspona sa svakog sjedala.",
      "Open limp s rukama koje su dovoljno dobre za raise ili dovoljno loše za fold.",
      "Preširoko otvaranje s ranih sjedala, gdje su ruke koje te callaju ili 3-betaju jake.",
      "Velik open s kasnih pozicija, gdje manji riskira manje za iste blindove.",
    ],
    tryIt: "Postavi veličinu opena i blindove i vidi koliko često open mora odmah uspjeti ako nikad ne pobjeđuje kad je callan.",
  },

  "three-bet": {
    summary: "Prvi re-raise prije flopa i re-raise koji slijedi na njega: s value rukama gradiš pot, a fold equityjem ga uzimaš.",
    definition: [
      "Preflop se big blind računa kao prvi bet, pa je open drugi bet, a prvi re-raise 3-bet. Re-raise na njega je 4-bet.",
      "Raspon za 3-bet miješa jake ruke koje žele veći pot (value) s rukama kojima odgovara odmah osvojiti pot, a i kad su callane igraju dobro (blefovi) — često su to male suited ase, koje usto blokiraju najjače ruke, i suited konektori. Neki igrači 3-betaju linearnije, odozgo prema dolje, osobito u poziciji protiv širokih openova.",
      "Uobičajene veličine: oko trostrukog opena u poziciji, oko četverostrukog izvan pozicije, a 4-bet oko 2,2 do 2,5 puta veći od 3-beta.",
    ],
    why: [
      "3-bet dovoljno često odmah osvaja pot da se isplati i s nekim rukama koje bi kao call teško prolazile. Usto otvaraču oduzima priliku da jeftino vidi flop i realizira svoj equity.",
      "Snižava SPR, pa je jake ruke s jednim parom nakon flopa lakše igrati za stackove.",
      "Raspon koji 3-beta samo premium ruke lako je igrati: protiv njega foldaš sve osim nutsa. Blefovi su ono zbog čega value ruke dobivaju isplatu.",
    ],
    formulas: [
      {
        name: "Postotak foldova koji treba 3-bet blefu",
        expression: { frac: ["3-bet", "3-bet + pot"] },
        spoken: "Postotak foldova koji treba 3-bet blefu jednak je čipovima koje 3-bet riskira, podijeljenima s tim čipovima plus pot koji je već u sredini.",
      },
    ],
    example: {
      title: "3-bet s buttona protiv opena s cutoffa",
      setup: "Cutoff otvara na 2,5 bb, a ti s buttona 3-betaš na 8 bb. Pot prije tvojeg 3-beta je 2,5 + 0,5 + 1 = 4 bb.",
      steps: [
        "Kao čisti blef, 3-bet mora osvojiti pot 8 / (8 + 4) ≈ 66,7 % vremena — cutoff i oba blinda moraju foldati.",
        "Ilustrativni raspon za 3-bet s buttona na ovim stranicama je TT+, AJs+, AKo, AQo, KQs, A5s, A4s, 76s i 65s: 86 kombinacija, oko 6,5 % svih ruku.",
        "70 od tih kombinacija su jake ruke; preostalih 16 (A5s, A4s, 76s, 65s) su blefovi.",
        "Asevi blokiraju AA i AK; konektori kad su callani rade skale i dva para.",
      ],
      takeaway: "Blefovi se biraju po tome što rade kad su callani i što uklanjaju iz ruku koje nastavljaju — ne samo zato što su preslabi za call.",
    },
    mistakes: [
      "3-betanje samo premium ruku, pa svaki 3-bet igraš otvorenih karata.",
      "Callanje 3-betova izvan pozicije s dominiranim rukama poput KJo ili ATo.",
      "4-bet blefovi s rukama koje ništa ne blokiraju.",
      "Mali 3-bet izvan pozicije, koji otvaraču daje jeftin call u poziciji.",
    ],
    tryIt: "Odaberi svoju ruku i vidi koliko uklanja iz ruku koje bi nastavile protiv tvojeg 3-beta ili 4-beta.",
  },

  squeeze: {
    summary: "3-bet nakon opena i calla: više novca u sredini i caller koji vjerojatno nije jak.",
    definition: [
      "Squeeze je 3-bet nakon što je jedan igrač otvorio, a barem još jedan callao.",
      "Djeluje iz dva razloga: callerovi čipovi su mrtvi novac koji možeš osvojiti, a callerov raspon je obično ograničen odozgo (capped) — s najjačim rukama sam bi 3-betao. Otvarač je pritom zarobljen između tebe i callera.",
    ],
    why: [
      "Više novca u potu znači da isti squeeze mora uspjeti nešto rjeđe nego 3-bet protiv samog otvarača.",
      "Ali foldati moraju dvojica, a ne jedan. Zato su squeezeovi veći od običnih 3-betova — otprilike jedna veličina opena više za svakog callera — i zato se oslanjaju na ruke koje dobro igraju kad su callane.",
    ],
    formulas: [
      {
        name: "Postotak foldova koji treba squeeze blefu",
        expression: { frac: ["squeeze", "squeeze + pot"] },
        spoken: "Postotak foldova koji treba squeeze blefu jednak je čipovima koje squeeze riskira, podijeljenima s tim čipovima plus pot koji je već u sredini.",
      },
    ],
    example: {
      title: "Squeeze s buttona",
      setup: "Hijack otvara na 2,5 bb, cutoff calla, a ti s buttona squeezaš na 12 bb. Pot prije tvoje akcije je 2,5 + 2,5 + 0,5 + 1 = 6,5 bb.",
      steps: [
        "Kao čisti blef mora osvojiti pot 12 / (12 + 6,5) ≈ 64,9 % vremena.",
        "Ako otvarač i caller svaki foldaju 80 % vremena, obojica foldaju 0,8 × 0,8 = 64 % — tik ispod potrebnog.",
        "Callerov ograničeni raspon folda češće, recimo 90 %: 0,8 × 0,9 = 72 %, sigurno iznad cijene.",
      ],
      takeaway: "Squeeze je profitabilan zato što je caller slab, a ne samo zato što je u sredini više novca. Protiv callera koji s velikim rukama postavlja zamku, to je samo skupi 3-bet.",
    },
    mistakes: [
      "Squeeze iste veličine kao 3-bet protiv jednog igrača.",
      "Lagani squeeze protiv callera za kojeg se zna da flata jake ruke.",
      "Squeeze izvan pozicije iz blindova s rukama koje loše igraju kad su callane.",
    ],
    tryIt: "Promijeni mrtvi novac i veličinu squeezea i vidi koliko često mora uspjeti.",
  },

  "blind-defence": {
    summary: "Obrana blindova protiv opena: odlična cijena, koju plaćaš igrom izvan pozicije.",
    definition: [
      "Big blind već ima 1 bb u potu i preflop zatvara akciju, pa ga call opena stoji manje nego bilo koga drugog. Zbog tog popusta big blind brani daleko više ruku nego što ijedno drugo sjedalo calla.",
      "Small blind je drugačiji: izvan pozicije je protiv svih, uključujući big blind koji iza njega tek treba odigrati, i ne zatvara akciju. Iz small blinda obrana je uglavnom 3-bet ili fold.",
    ],
    why: [
      "Cijena ovisi o veličini opena. Protiv opena od 2 bb big blindu treba oko 22 % equityja, protiv 2,5 bb oko 27 %, protiv 3 bb oko 31 %.",
      "Equity nije sve: izvan pozicije ruke ga realiziraju manje. Ruke koje rade jake ruke — suited, povezane — brane se šire od offsuit ruku sa slabim kickerima.",
      "Prečesto foldanje iz big blinda jedan je od najčešćih i najskupljih preflop leakova, jer se blindovi postavljaju svaku orbitu.",
    ],
    formulas: [
      {
        name: "Potreban equity",
        expression: { frac: ["call", "pot + call"] },
        spoken: "Equity koji treba big blindu jednak je callu podijeljenom s potom plus call, pri čemu pot uključuje open.",
      },
    ],
    example: {
      title: "J♣5♦ protiv opena s buttona",
      setup: "Button otvara, a small blind folda. Protiv ilustrativnog raspona buttona na ovim stranicama J♣5♦ ima oko 36 % equityja.",
      steps: [
        "Protiv opena od 2,5 bb: pot je 2,5 + 0,5 + 1 = 4 bb, a call 1,5 bb, pa je cijena 1,5 / 5,5 ≈ 27,3 %.",
        "Protiv opena od 2 bb: pot je 3,5 bb, a call 1 bb — 1 / 4,5 ≈ 22,2 %.",
        "Pretpostavimo da J♣5♦ izvan pozicije realizira 65 % svojeg equityja: 0,36 × 0,65 ≈ 23,4 %.",
        "To je ispod 27,3 %, ali iznad 22,2 %.",
      ],
      takeaway: "Protiv većeg opena foldaj, protiv min-raisea brani. Veličina opena pomiče dno raspona big blinda, a faktor realizacije — ovdje pretpostavka — odlučuje gdje.",
    },
    mistakes: [
      "Prečesto foldanje iz big blinda protiv openova s kasnih pozicija.",
      "Previše callanja iz small blinda, koji je izvan pozicije i ne zatvara akciju.",
      "Branjenje istog raspona protiv opena iz under the guna kao protiv opena s buttona.",
      "Zanemarivanje veličine opena.",
    ],
    tryIt: "Postavi pot i call za različite veličine opena i vidi kakvu cijenu big blind dobiva.",
  },

  steal: {
    summary: "Otvaranje s kasnih sjedala da osvojiš blindove: bet koji je profitabilan čak i kad često ne uspije.",
    definition: [
      "Steal je open s cutoffa, buttona ili iz small blinda kad su svi prije foldali, s rasponom puno širim od ruku koje su jake same po sebi. Glavni cilj je odmah osvojiti blindove (i ante).",
      "Riskira veličinu opena da osvoji ono što je već u sredini, pa ima jednostavan break-even postotak foldova — a kad je callan, i dalje ima equity, a često i poziciju.",
    ],
    why: [
      "Blindovi su u igri svaku orbitu. Pokupiti ih dovoljno često značajan je dio rezultata pobjedničkog igrača, a premalo stealanja prepušta ih svima ostalima.",
      "Ante mijenja cijenu: više mrtvog novca, pa steal mora uspjeti rjeđe.",
      "Blindovi uzvraćaju 3-betovima i obranom. Raspon za steal ispravan je samo u odnosu na to kako blindovi igraju.",
    ],
    formulas: [
      {
        name: "Break-even postotak foldova",
        expression: { frac: ["open", "open + blindovi + ante"] },
        spoken: "Break-even postotak foldova za steal jednak je veličini opena podijeljenoj s veličinom opena plus blindovi i ante.",
      },
    ],
    example: {
      title: "Tri steala s buttona",
      setup: "Otvaraš s buttona s rukom koja nikad neće pobijediti ako bude callana — najgori slučaj.",
      steps: [
        "2,5 bb u 1,5 bb blindova: potrebno je 2,5 / (2,5 + 1,5) = 62,5 % foldova.",
        "3 bb umjesto toga: 3 / 4,5 ≈ 66,7 %. Veće nije bolje kad je cilj osvojiti blindove.",
        "2,5 bb uz ante od 0,1 bb od svakog od 6 igrača: pot je 2,1 bb, pa 2,5 / 4,6 ≈ 54,3 %.",
      ],
      takeaway: "Stvarni break-even još je niži, jer callani steal zadržava svoj equity i obično poziciju. Zato su rasponi s buttona široki.",
    },
    mistakes: [
      "Steal s prevelikim openovima.",
      "Jednako širok steal protiv blindova koji vrlo često 3-betaju.",
      "Premalo stealanja s buttona.",
      "Odustajanje na svakom flopu nakon što je steal callan.",
    ],
    tryIt: "Postavi blindove (dodaj ante) i veličinu opena: kalkulator pokazuje koliko često steal mora odmah uspjeti.",
  },
};

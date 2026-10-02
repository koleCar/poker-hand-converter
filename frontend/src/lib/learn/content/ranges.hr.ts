import type { ConceptTexts } from "./types";

/**
 * Ranges and boards, Croatian. Same shape as `ranges.en.ts`, with the same
 * numbers in every example (written with a decimal comma). Poker words stay
 * the ones Croatian players use; texture words match `i18n/ns/analysis.hr.ts`.
 */
export const rangesHr: ConceptTexts<"ranges" | "range-advantage" | "nut-advantage" | "board-texture" | "dynamic-boards" | "blockers"> = {
  ranges: {
    summary: "Nitko ne drži „jednu ruku” — drži svaku ruku koju bi odigrao na ovaj način, a ti odlučuješ protiv svih njih.",
    definition: [
      "Raspon (range) je skup ruku koje igrač može imati s obzirom na sve što je dosad napravio, svaka s težinom koja govori koliko je vjerojatna. Open s buttona može biti 40 % svih ruku; 4-bet istog igrača tek nekoliko posto.",
      "Rasponi se broje u kombinacijama. Postoji 1.326 početnih ruku od dvije karte, svrstanih u 169 klasa: par (QQ) ima 6 kombinacija, suited ruka (AKs) 4, a offsuit ruka (AKo) 12. Skraćenice poput „77+” (sedmice i svaki veći par) ili „ATs+” (od AT suited do AK suited) zapisuju raspon u jednom retku.",
    ],
    why: [
      "Protivnikove karte nikad ne vidiš, pa je odluka dobra ili loša uvijek samo u odnosu na ruke koje on može imati. Staviti nekoga na jednu točnu ruku je nagađanje; raspon je pošten oblik tog nagađanja.",
      "Svaka akcija sužava raspon. Call preflop uklanja ruke koje bi raiseale; check-raise na riveru uklanja većinu ruku koje bi samo callale. Praćenje tog sužavanja street po street najveći je dio čitanja ruke.",
      "Tvoj vlastiti raspon jednako je važan. Ako na riveru betaš samo s nutsom, protivnik koji razmišlja foldat će sve ostalo — tvoja se ruka čita kroz tvoj raspon.",
    ],
    formulas: [
      {
        name: "Kombinacije",
        expression: ["par 6 · suited 4 · offsuit 12"],
        spoken: "Džepni par ima 6 kombinacija, suited ruka 4, a offsuit ruka 12.",
      },
      {
        name: "Udio raspona",
        expression: { frac: ["kombinacije u rasponu", "1.326"] },
        spoken: "Udio raspona u svim početnim rukama jednak je broju njegovih kombinacija podijeljenom s 1.326.",
      },
    ],
    example: {
      title: "J♥J♦ protiv 3-beta",
      setup: "Otvaraš s J♥J♦, a protivnik napravi 3-bet. Recimo da 3-bet radi samo s QQ+ i AK.",
      steps: [
        "Prebroji raspon: AA, KK i QQ imaju po 6 kombinacija, AK ima 16 (4 suited, 12 offsuit). Ukupno 34 kombinacije.",
        "Protiv QQ+ tvoj J♥J♦ ima oko 18,4 % equityja. Protiv AK oko 56,1 %.",
        "Ponderirano kombinacijama: (18 × 18,4 % + 16 × 56,1 %) / 34 ≈ 36,2 %.",
      ],
      takeaway: "„Jesam li ispred AK?” pogrešno je pitanje. Protiv cijelog raspona JJ ima oko 36 % — a širi raspon 3-beta s nešto blefova u sebi brzo mijenja tu brojku.",
    },
    mistakes: [
      "Staviti protivnika na jednu točnu ruku i igrati protiv nje.",
      "Ne sužavati raspon: igrača koji je betao tri streeta tretirati kao da i dalje može imati svaku ruku s kojom je otvorio.",
      "Brojati klase umjesto kombinacija — AK nije jedna ruka, nego 16, i dvaput je češći od bilo kojeg para.",
      "Zaboraviti vlastiti raspon: što tvoja linija govori o tebi nekome tko pazi.",
    ],
    tryIt: "Odaberi ruku i ilustrativni raspon; equity se računa protiv svake kombinacije u rasponu, bez tvojih karata i karata s boarda.",
  },

  "range-advantage": {
    summary: "Na danom boardu: čiji cijeli raspon ima više equityja — o tome ovisi tko može često betati.",
    definition: [
      "Prednost raspona (range advantage) uspoređuje dva raspona, a ne dvije ruke: koliko equityja na ovom boardu ima cijeli raspon svakog igrača protiv raspona drugoga? To je prosjek equityja svih ruku, ponderiran kombinacijama.",
      "Preflop rasponi različito se susreću s boardom. Open s buttona ima više visokih karata od calla big blinda; big blind ima više malih i srednjih suited ruku. Zato suhi flop s kraljem kao najvišom kartom pogoduje otvaraču, a nizak povezan flop smanjuje razliku ili je preokreće.",
    ],
    why: [
      "Igrač s prednošću raspona može betati velik dio raspona, često malim betom: većina njegovih ruku je ispred, a ostale imaju dovoljno equityja da idu dalje.",
      "Igrač bez nje češće checka i pažljivo brani; betati prvi u jači raspon rijetko se isplati.",
      "To je prvo pitanje u gotovo svakoj postflop situaciji, jer oblikuje frekvencije obaju igrača prije nego što se pogleda ijedna ruka.",
    ],
    formulas: [
      {
        name: "Equity raspona",
        expression: { frac: ["Σ kombinacije × equity", "Σ kombinacije"] },
        spoken: "Equity raspona jednak je zbroju, po svim njegovim rukama, broja kombinacija puta equity, podijeljenom s ukupnim brojem kombinacija.",
      },
    ],
    example: {
      title: "Open s buttona protiv calla big blinda",
      setup: "S ilustrativnim rasponima iz widgeta ispod: raspon otvaranja s buttona protiv raspona calla big blinda, na dva flopa.",
      steps: [
        "Na K♦7♣2♥ raspon buttona ima oko 53 % equityja protiv raspona big blinda.",
        "Na 8♥7♥6♣ isti su rasponi gotovo izjednačeni — button ima oko 49 %.",
        "Open s UTG-a protiv big blinda još je više ispred na oba flopa: oko 59 % na K♦7♣2♥ i 53 % na 8♥7♥6♣.",
      ],
      takeaway: "Što je raspon otvaranja uži, to mu je prednost veća — a nizak povezan board svaki dvoboj vraća prema izjednačenom.",
    },
    mistakes: [
      "Procjenjivati situaciju samo po vlastitoj ruci.",
      "Pretpostavljati da preflop raiser uvijek ima prednost. Na nekim boardovima ima je caller.",
      "Miješati prednost raspona (tko je u prosjeku ispred) s prednošću u nutsu (tko ima više najjačih ruku).",
    ],
    tryIt: "Promijeni dvoboj i board i gledaj kako se pomiče podjela equityja. Rasponi su napisani ručno za učenje, nisu izračunati solverom.",
  },

  "nut-advantage": {
    summary: "Tko drži više najjačih ruku na ovom boardu — o tome ovisi tko može betati veliko.",
    definition: [
      "Prednost u nutsu (nut advantage) postavlja uže pitanje od prednosti raspona: od svih ruku koje su na ovom boardu pri samom vrhu, čiji ih raspon ima više?",
      "Rail je svugdje mjeri na isti način: svaku kombinaciju od dvije karte koju board ostavlja rangira prema onome što složi, uzme najjačih 10 % i prebroji koliki je udio svakog raspona u toj skupini.",
    ],
    why: [
      "Prednost raspona govori ti koliko često betati; prednost u nutsu govori koliko veliko. Veliki betovi i overbetovi trebaju nuts iza sebe, jer samo raspon s više vrlo jakih ruku može uložiti puno novca i i dalje imati vrijednost kad dobije call.",
      "Igrač može imati jednu bez druge. Preflop raiser može biti u prosjeku ispred, a na niskom povezanom boardu imati manje setova i skala od callera koji je branio sve suited connectore.",
      "I check-raiseovi dolaze iz prednosti u nutsu: igrač s više jakih ruku u tom dijelu raspona može raiseati veliko i imati ruke koje to opravdavaju.",
    ],
    formulas: [
      {
        name: "Udio u nutsu",
        expression: { frac: ["kombinacije među najjačih 10 % ruku na ovom boardu", "kombinacije u rasponu"] },
        spoken: "Udio raspona u nutsu jednak je broju njegovih kombinacija među najjačih 10 % ruku na ovom boardu, podijeljenom s brojem svih njegovih kombinacija.",
      },
    ],
    example: {
      title: "Dva flopa, dva predvodnika",
      setup: "S ilustrativnim rasponima iz widgeta pogledaj najjačih 10 % ruku na svakom boardu.",
      steps: [
        "Open s UTG-a protiv calla big blinda na A♠8♦3♣: oko 35 % raspona otvarača je među najjačih 10 %, naspram oko 19 % raspona callera. Velika prednost pri vrhu.",
        "Open s buttona protiv calla big blinda na J♠T♠9♠: button ima oko 48 % equityja raspona i samo oko 18 % raspona među najjačih 10 % — big blind ima oko 24 %.",
      ],
      takeaway: "Na A♠8♦3♣ otvarač može betati veliko. Na J♠T♠9♠ caller ima obje prednosti, a veliki betovi otvarača nailaze na ruke koje ih pobjeđuju.",
    },
    mistakes: [
      "Overbetati zato što si u prosjeku ispred, a bez jakih ruku zbog kojih overbet funkcionira.",
      "Pretpostavljati da caller nikad nema nuts. Na niskim i povezanim boardovima često ga ima više.",
      "Gledati samo snagu vlastite ruke, a ne koliko jakih ruku ima svaki raspon.",
    ],
    tryIt: "Usporedi udio svakog raspona među najjačih 10 % dok mijenjaš board i dvoboj.",
  },

  "board-texture": {
    summary: "Uparen, istobojan, povezan, visok ili nizak: oblik boarda određuje koje ruke i drawovi postoje.",
    definition: [
      "Tekstura boarda kratak je opis zajedničkih karata, riječima kojima se služe igrači:",
      "Uparen ili ne. Boje: rainbow (tri boje na flopu), dvobojan (dvije karte iste boje — moguć je flush draw) ili jednobojan (jedna boja — flush je već moguć). Povezanost: koliko kombinacija od dvije karte slaže skalu; Rail board bez nijedne zove nepovezanim, s jednom ili dvije djelomično povezanim, a s tri ili više povezanim. I najviša karta: s asom, visok (broadway, od T do K), srednji (od 7 do 9) ili nizak (6 i niže).",
    ],
    why: [
      "Tekstura određuje što postoji. Na K♦7♣2♥ nema ni straight ni flush drawova; na 8♥7♥6♣ postoje skale, otvoreni straight drawovi, flush drawovi i njihove kombinacije.",
      "Određuje i kome board pogoduje. Visoki boardovi pogađaju preflop raisere; niski povezani boardovi pogađaju callere koji brane male suited ruke.",
      "I određuje veličinu beta: na suhom boardu jedan mali bet obavi većinu posla; na mokrom boardu ruke trebaju zaštitu, a drawove treba naplatiti.",
    ],
    example: {
      title: "Čitanje četiri flopa",
      setup: "Alat ispod koristi iste funkcije kao analiza tvojih ruku.",
      steps: [
        "K♦7♣2♥: neuparen, rainbow, nepovezan (nikoje dvije karte ne slažu skalu), visok (broadway).",
        "8♥7♥6♣: dvobojan, povezan (T9, 95 i 54 svi slažu skalu), srednji.",
        "Q♣5♦5♥: uparen, rainbow, nepovezan.",
        "J♠T♠9♠: jednobojan (bilo koja dva pika slažu flush), povezan.",
      ],
      takeaway: "Svaka riječ uklanja ili dodaje cijelu obitelj ruku. Spoji ih i imaš prvu skicu obaju raspona na tom flopu.",
    },
    mistakes: [
      "Opisivati board samo po bojama. Povezanost i visina jednako su važne.",
      "Svaki neuparen rainbow board zvati „suhim”. 9♥8♦7♣ je rainbow i pun skala.",
      "Zaboraviti da je tekstura zajednička: isti board koji tebi daje draw daje protivniku ruke koje ga pobjeđuju.",
    ],
    tryIt: "Odaberi tri do pet karata ili kreni od predloška i pogledaj kako je board klasificiran.",
  },

  "dynamic-boards": {
    summary: "Dinamičan board se sa sljedećom kartom jako mijenja; statičan se jedva pomakne. Rail mjeri koji je koji.",
    definition: [
      "Neki boardovi ostaju ono što jesu: na K♦7♣2♥ najbolja ruka na flopu vrlo je često i najbolja ruka na riveru. Drugi su u pokretu: na 8♥7♥6♣ velik dio karata na turnu dovrši neki draw ili stvori novi.",
      "Rail to mjeri tako da pogleda svaku moguću sljedeću kartu i prebroji koliko bi ih promijenilo board: treća karta iste boje (flush postaje moguć), karta koja dodaje dvije ili više novih kombinacija koje slažu skalu, ili overkarta na boardu, koja se broji kao pola. Ako ga mijenja manje od 25 % sljedećih karata, board je statičan; od 45 % naviše dinamičan je; između je umjereno dinamičan. River nema sljedeću kartu, pa nije ni jedno ni drugo.",
    ],
    why: [
      "Na dinamičnim boardovima equity se brzo seli: ruka koja je sada ispred na turnu može biti iza. Jake ruke žele betati da drawovi plate sljedeću kartu, a srednje ruke teže je igrati.",
      "Na statičnim boardovima manje je toga od čega se treba štititi. Mali betovi, tanki value i check iza radi kontrole pota bolje funkcioniraju, jer turn rijetko mijenja tko je ispred.",
      "Dinamičnost boarda ujedno je ono što neke situacije čini skupima ako ih odigraš krivo: što su zamasi veći, to pasivna igra može više koštati.",
    ],
    formulas: [
      {
        name: "Volatilnost",
        expression: { frac: ["karte koje mijenjaju board + ½ × overkarte", "neviđene karte"] },
        spoken: "Volatilnost je jednaka broju sljedećih karata koje mijenjaju board, uvećanom za pola overkarata koje ne mijenjaju ništa drugo, podijeljenom s brojem neviđenih karata.",
      },
    ],
    example: {
      title: "Statičan i dinamičan, jedan uz drugi",
      setup: "Na flopu je 49 neviđenih karata.",
      steps: [
        "K♦7♣2♥: overkarte su samo asovi, a nijedna karta na turnu ne dodaje flush ni dvije kombinacije za skalu odjednom — volatilnost oko 4 %. Statičan.",
        "8♥7♥6♣: svaki herc donosi treći herc, a mnoge karte dodaju nove skale — volatilnost oko 59 %. Dinamičan.",
        "Dodaj 3♠ na K♦7♣2♥ i volatilnost boarda na turnu raste na oko 21 % — i dalje statičan.",
      ],
      takeaway: "Tekstura flopa govori ti što postoji; njegova dinamičnost govori koliko će se brzo to promijeniti.",
    },
    mistakes: [
      "Slowplay jakih ruku na dinamičnim boardovima, čime drawovima koji te pobjeđuju daješ besplatne karte.",
      "Betati veliko radi zaštite na statičnim boardovima, gdje se gotovo nema od čega štititi, a callaju samo bolje ruke.",
      "Smatrati svaki dvobojan board dinamičnim: dvobojan K♦7♦2♣ doseže tek umjerenu dinamičnost — flush draw mu je jedini dio u pokretu.",
    ],
    tryIt: "Složi flop i prati volatilnost: dodaj drugu kartu iste boje, smanji razmake između vrijednosti karata, pa probaj kartu na turnu.",
  },

  blockers: {
    summary: "Tvoje karte nisu ni u čijoj drugoj ruci: držiš li jednu, uklanjaš kombinacije kojima ona treba.",
    definition: [
      "Blocker je karta koju držiš, a koja protivniku čini određene ruke manje vjerojatnima, jer bi mu trebala upravo ta karta. Kad držiš A♠, AA ima još 3 kombinacije umjesto 6, a AK 12 kombinacija umjesto 16.",
      "Druga strana je unblocking: ne držati karte ruku koje želiš da protivnik ima. Blef najbolje prolazi kad ne blokiraš ruke koje foldaju.",
    ],
    why: [
      "Blockeri presuđuju u tijesnim odlukama. Kad dvije ruke vrijede otprilike jednako, ona koja uklanja više protivnikovih jakih ruku bolji je blef — a ona koja uklanja više njegovih blefova lošiji je bluff-catcher.",
      "Najvažniji su kad su rasponi uski — kasno u ruci ili nakon nekoliko raiseova preflop — jer je svaka uklonjena kombinacija veći udio onoga što je ostalo.",
      "Blokira i board: kralj na flopu ostavlja 3 kombinacije KK, a ne 6.",
    ],
    formulas: [
      {
        name: "Preostale kombinacije para",
        expression: ["C(preostale karte, 2): 6 → 3 → 1"],
        spoken: "Džepni par ima 6 kombinacija kad su dostupne sve četiri karte, 3 kad je jedna uklonjena i 1 kad su uklonjene dvije.",
      },
      {
        name: "Preostale kombinacije neuparene ruke",
        expression: ["(preostale karte prve vrijednosti) × (preostale karte druge vrijednosti)"],
        spoken: "Broj kombinacija neuparene ruke jednak je broju preostalih karata njezine prve vrijednosti puta broj preostalih karata njezine druge vrijednosti.",
      },
    ],
    example: {
      title: "4-bet blef s A♠5♠",
      setup: "Protivnik protiv 4-beta nastavlja s QQ+ i AK: 6 + 6 + 6 + 16 = 34 kombinacije.",
      steps: [
        "Tvoj A♠ uklanja pola asova: AA pada sa 6 kombinacija na 3.",
        "AK pada sa 16 na 12 (3 od 4 suited, 9 od 12 offsuit).",
        "KK i QQ ostaju netaknuti: po 6.",
        "Raspon s kojim nastavlja pada s 34 kombinacije na 27 — oko 21 % manje.",
      ],
      takeaway: "Zato su mali suited asovi klasični 4-bet blefovi: as uklanja velik dio ruku koje nastavljaju, a ruka i dalje ima nešto equityja kad dobije call.",
    },
    mistakes: [
      "Blefirati zbog jednog blockera kad je protivnikov raspon i dalje većinom sastavljen od jakih ruku.",
      "Blokirati ruke koje foldaju. Blef s kartama s kojima bi protivnik foldao čini vjerojatnijim da ima nešto što calla.",
      "Zaboraviti board: karte na stolu uklanjaju kombinacije obama igračima.",
    ],
    tryIt: "Odaberi svoje dvije karte (i board) i pogledaj koliko je kombinacija svake klase ostalo.",
  },
};

import type { LessonOutlines } from "./types";

/**
 * Every lesson's outline, Croatian. Same ids and the same number of goals as
 * `outline.en.ts`; a summary of at most 155 characters (the page's meta
 * description) and goals that start with a verb. The reader is addressed with
 * "ti"; poker words stay as the concept library writes them ("raspon" for
 * range, "prednost raspona", "prednost u nutsu", "izvan pozicije").
 */
export const outlineHr: LessonOutlines = {
  // ---- M0 orientation
  "how-rail-teaches": {
    summary: "Kako radi Railov ciklus učenja (nauči ideju, uvježbaj je, igraj, pregledaj svoje ruke) i što ti govore ocjene i gubitak EV-a.",
    goals: [
      "Prati ciklus: nauči ideju, uvježbaj je, igraj, a zatim pregledaj svoje ruke.",
      "Pročitaj ocjenu i gubitak EV-a iza nje i razlikuj tijesnu odluku od prave greške.",
      "Planiraj kratke, raznolike treninge umjesto dugog ponavljanja jedne situacije.",
      "Usredotoči se na jedan format, i to najprije na cash igre.",
    ],
  },
  "gto-mixing-and-simplifying": {
    summary: "Što je zapravo strategija ravnoteže, zašto solveri neke ruke dijele između dviju akcija i kad te jednostavnija igra ne košta gotovo ništa.",
    goals: [
      "Objasni ravnotežu kao strategiju koju nitko ne može pobijediti, a ne kao najbolju igru protiv svakoga.",
      "Objasni zašto ruka koja miješa akcije sa svakom od njih zarađuje gotovo isto.",
      "Procijeni odluku po gubitku EV-a, a ne po tome koliko je često referenca bira.",
      "Odaberi jednostavniju akciju kad je razlika u EV-u mala.",
      "Shvati ravnotežu kao polazište od kojeg kreće svaki exploit.",
    ],
  },
  "reading-rail-reports": {
    summary: "Kako čitati Railov pregled, raščlambe i popis leakova te kako razlikovati leak koji košta novac od šuma u malom uzorku.",
    goals: [
      "Snađi se u pregledu, raščlambama, usporedbi s referencom i leakovima.",
      "Izrazi rezultate u big blindovima na 100 ruku da pošteno usporediš sesije i situacije.",
      "Rangiraj leakove po big blindovima koje koštaju, a ne po tome koliko frekvencija odstupa.",
      "Razlikuj leak na tankom uzorku od onoga kojem možeš vjerovati.",
      "Otvori ruke iza svog najvećeg leaka i ponovno ih odigraj.",
    ],
  },
  "variance-bankroll-and-tilt": {
    summary: "Zašto rezultati kratkoročno toliko odstupaju od vještine, kako pomažu all-in EV i veličina uzorka te jednostavna pravila za bankroll i stop-loss.",
    goals: [
      "Procijeni odluku po očekivanoj vrijednosti, a ne po tome kako je ruka završila.",
      "Izračunaj all-in EV i usporedi ga s novcem koji si stvarno osvojio.",
      "Objasni zašto mali uzorak malo govori o tvom stvarnom win rateu.",
      "Postavi pravila za bankroll i stop-loss kojih ćeš se držati.",
      "Prepoznaj tilt kao porast grešaka nakon velikih gubitaka.",
    ],
  },

  // ---- M1 poker maths
  "pot-odds": {
    summary: "Kako izračunati koliki dio konačnog pota košta call, a time i koliko equityja call treba da bude na nuli.",
    goals: [
      "Izračunaj potreban equity kao call podijeljen s potom nakon tvog calla.",
      "Pretvori pot odds iz omjera u postotak i natrag.",
      "Ubroji bet u pot da nikad krivo ne procijeniš cijenu calla.",
      "Prepoznaj kad pot odds nisu dovoljni jer dolaze još karte i betovi.",
    ],
  },
  "equity-and-outs": {
    summary: "Kako prebrojati outove, brzo iz njih procijeniti equity i prepoznati kad ta prečica daje krivi odgovor.",
    goals: [
      "Prebroji čiste outove i odbij one koji pomažu i protivniku.",
      "Procijeni equity iz outova množenjem s dva ili s četiri.",
      "Objasni zašto prečica na flopu pretpostavlja da vidiš dvije karte za jednu cijenu.",
      "Koristi equity za jednu kartu kad je na turnu vjerojatan još jedan bet.",
      "Usporedi svoju procjenu s točnim equityjem koji računa Rail.",
    ],
  },
  "expected-value": {
    summary: "Što znači očekivana vrijednost, kako je izračunati za call ili za bet koji može odmah osvojiti pot i zašto je fold nulta točka.",
    goals: [
      "Izračunaj EV tako da svaki ishod pomnožiš s njegovom vjerojatnošću i sve zbrojiš.",
      "Uzmi fold kao nulu prema kojoj se mjeri svaka druga opcija.",
      "Izračunaj EV calla i EV beta koji protivnika može natjerati na fold.",
      "Objasni zašto mnogi profitabilni potezi ipak češće gube nego što dobivaju.",
      "Čitaj Railov gubitak EV-a kao razliku između svog izbora i najbolje opcije.",
    ],
  },
  "combos-and-card-removal": {
    summary: "Na koliko se načina može podijeliti svaka ruka, kako board i tvoje karte neke od njih uklanjaju i zašto to mijenja što protivnik drži.",
    goals: [
      "Prebroji kombinacije para, suited ruke i offsuit ruke.",
      "Ukloni kombinacije koje board i tvoje karte čine nemogućima.",
      "Usporedi koliko value kombinacija i koliko blefova ima u rasponu.",
      "Objasni kako jedna karta u tvojoj ruci mijenja ono što protivnik može imati.",
    ],
  },
  "bluffing-math-alpha-mdf": {
    summary: "Koliko često blef mora uspjeti za svoju veličinu, koliki dio raspona mora nastaviti protiv beta i gdje ti brojevi prestaju vrijediti.",
    goals: [
      "Izračunaj koliko često blef zadane veličine mora uspjeti.",
      "Izračunaj koliki dio raspona mora nastaviti da čisti blef ne bude profitabilan.",
      "Poveži veći bet s više foldova koje treba onaj tko beta i manje callova koje treba branitelj.",
      "Objasni zašto su oba broja prije rivera i protiv igrača koji rijetko blefiraju samo smjernice.",
    ],
  },
  "equity-realisation-and-implied-odds": {
    summary: "Zašto isti equity vrijedi više u poziciji i s igrivim rukama te kad novac koji možeš osvojiti kasnije opravdava call sada.",
    goals: [
      "Objasni kako pozicija, suited karte i povezanost mijenjaju koliko equityja ruka stvarno realizira.",
      "Razlikuj implied odds od reverse implied odds.",
      "Procijeni kad duboki stackovi i dobro skrivena ruka čine call isplativim.",
      "Biraj obranu big blinda protiv opena s buttona po igrivosti, a ne po sirovom equityju.",
    ],
  },

  // ---- M2 ranges
  "thinking-in-ranges": {
    summary: "Kako prestati pogađati jednu ruku i zamisliti sve ruke koje protivnik može imati, polazeći od mreže 13×13 i akcije prije flopa.",
    goals: [
      "Čitaj mrežu ruku 13×13 i pronađi na njoj bilo koju klasu ruku.",
      "Sastavi vjerojatan preflop raspon iz igračeva sjedala i akcije.",
      "Objasni kako svaka akcija iz raspona uklanja neke ruke.",
      "Proširi i preoblikuj raspon za igrače koji igraju labavije ili manje logično.",
    ],
  },
  "range-advantage": {
    summary: "Čiji cijeli raspon prolazi bolje na određenom flopu, zašto tu prednost često ima preflop raiser i kako ona određuje koliko često tko beta.",
    goals: [
      "Definiraj prednost raspona kao equity jednog cijelog raspona protiv drugoga.",
      "Objasni zašto preflop raiser obično ima više visokih karata i velikih parova.",
      "Predvidi kojem igraču flop ide u prilog iz dviju preflop linija.",
      "Poveži prednost raspona s time koliko često igrač može betati.",
    ],
  },
  "nut-advantage": {
    summary: "Tko ima više najjačih ruku na boardu, po čemu se to razlikuje od prednosti raspona i zašto to određuje veličinu beta.",
    goals: [
      "Razlikuj prednost u nutsu od prednosti raspona.",
      "Odredi koji raspon na boardu ima više setova, skala i drugih vrhunskih ruku.",
      "Poveži prednost u nutsu s velikim betovima i overbetovima.",
      "Objasni zašto podjednak udio nutsa upućuje na manje betove.",
    ],
  },
  "board-texture": {
    summary: "Kako opisati flop (visok ili nizak, uparen, jednobojan ili dvobojan, povezan) i procijeniti koliko turn i river mogu promijeniti tko je ispred.",
    goals: [
      "Razvrstaj flopove po visini, uparenosti, bojama i povezanosti.",
      "Razlikuj statičan board od dinamičnog.",
      "Predvidi koliko kasnije karte mogu promijeniti tko vodi na boardu.",
      "Poveži statične boardove s malim betovima, a dinamične s većim betovima ili checkom.",
    ],
  },
  "who-the-next-card-helps": {
    summary: "Koje karte na turnu i riveru pomažu preflop raiseru, a koje calleru, i što učiniti kad karta odgovara tvom rasponu, ali ne i ruci.",
    goals: [
      "Prepoznaj koje karte na turnu idu u prilog preflop raiseru, a koje calleru.",
      "Objasni kako jedna karta može pomaknuti i prednost raspona i prednost u nutsu.",
      "Nastavi betati na kartama koje pomažu tvom rasponu i uspori na onima koje mu ne pomažu.",
      "Odluči igraš li svoj raspon ili svoju ruku prema vrsti protivnika.",
    ],
  },
  "range-narrowing": {
    summary: "Kako sužavati protivnikov raspon street po street prema svakoj akciji, da na river stigneš s kratkim popisom mogućih ruku.",
    goals: [
      "Ukloni ruke iz raspona nakon svake akcije: calla, checka, beta.",
      "Na svakom streetu pitaj se koje bi ruke umjesto toga raiseale, foldale ili betale.",
      "Stigni na river s kratkim popisom value ruku i blefova.",
      "Koristi suženi raspon za odluke o callu na riveru.",
    ],
  },

  // ---- M3 preflop
  "positions-and-opening-ranges": {
    summary: "Ime svakog sjedala za stolom 6-max i 9-max i zašto se rasponi otvaranja šire što si bliže buttonu.",
    goals: [
      "Imenuj svako sjedalo za stolom 6-max i 9-max.",
      "Objasni zašto se openi šire kad iza tebe ostaje manje igrača.",
      "Usporedi rana sjedala za punim stolom s UTG-om u 6-maxu.",
      "Biraj opene po sjedalu prema Railovim 6-max i 9-max chartovima.",
    ],
  },
  "open-sizing": {
    summary: "Što mijenja veličina tvog opena (cijenu za blindove, tko calla, SPR) i kako je prilagoditi limperima, anteima i live igri.",
    goals: [
      "Objasni kako veličina opena mijenja cijenu za blindove, raspone za call i SPR.",
      "Izračunaj koliko često steal mora uspjeti uz zadanu veličinu.",
      "Povećaj open za svakog igrača koji je već limpao.",
      "Prilagodi veličinu anteima, straddleima i labavijim live stolovima.",
    ],
  },
  "facing-an-open": {
    summary: "Kako birati između calla, 3-beta i folda kad netko otvori prije tebe, ovisno o tvom sjedalu i rakeu.",
    goals: [
      "Biraj između calla i 3-beta prema svojoj poziciji.",
      "Objasni zašto small blind naginje 3-betu ili foldu.",
      "Izbjegavaj call s rukama koje otvaračev raspon dominira.",
      "Uračunaj rake prije nego što samo callaš open.",
    ],
  },
  "three-betting": {
    summary: "Kako složiti 3-bet raspon, linearan ili polariziran, koje su ruke dobri 3-bet blefovi i koliko velik 3-bet raditi u poziciji i izvan nje.",
    goals: [
      "Razlikuj linearan od polariziranog 3-bet raspona i odaberi pravi oblik za situaciju.",
      "Biraj 3-bet blefove koji blokiraju jake ruke i dobro se igraju kad dobiju call.",
      "Radi veće 3-betove izvan pozicije i protiv većih opena.",
      "Prepoznaj ruke koje žele 3-bet, a ne call.",
    ],
  },
  "facing-3bets-and-4bets": {
    summary: "Kako odgovoriti kad tvoj open dobije 3-bet ili tvoj 3-bet dobije 4-bet: kad callati, kad ponovno raiseati, a kad pustiti ruku.",
    goals: [
      "Brani se od 3-beta rasponom koji ovisi o tvojoj poziciji.",
      "Odluči kad 4-betati za value, a kad kao blef.",
      "Odaberi koje ruke callaju 4-bet, a koje foldaju ili idu all-in.",
      "Foldaj češće na 4-betove pune value ruku, uobičajene na niskim ulozima i u live igri.",
    ],
  },
  "blind-play-and-bvb": {
    summary: "Kako popust big blinda omogućuje široku obranu, zašto small blind uglavnom raisea ili folda i kako se igraju potovi blind protiv blinda.",
    goals: [
      "Brani big blind prema cijeni koju dobivaš.",
      "Objasni zašto small blind radije raisea nego calla.",
      "Igraj blind protiv blinda s obaju sjedala.",
      "Prilagodi se kad su oba blinda jednaka i popust nestane.",
    ],
  },
  "squeezes-and-multiway-preflop": {
    summary: "Kad open i call ispred tebe čine squeeze profitabilnim, koliko velik squeeze raditi i kad je overcall bolji izbor.",
    goals: [
      "Prepoznaj priliku za squeeze po mrtvom novcu i ograničenom calleru.",
      "Povećaj squeeze za svakog igrača koji je već u potu.",
      "Biraj ruke za squeeze koje blokiraju jake raspone ili se dobro igraju kad dobiju call.",
      "Umjesto toga overcallaj sa suited rukama i parovima koji dobro prolaze u multiway potovima.",
    ],
  },
  "limpers-and-isolation": {
    summary: "Kako igrati protiv limpera: kad raiseati za izolaciju, koliko velik raise, kad je limp iza u redu i kako big blind igra limpane potove.",
    goals: [
      "Izoliraj slabe limpere raiseom koji raste sa svakim limperom.",
      "Odaberi veličinu koja će vjerojatno dovesti do heads-up pota.",
      "Odluči kad je limp iza bolji i od raisea i od folda.",
      "Odigraj opciju big blinda i limpane potove nakon flopa.",
    ],
  },

  // ---- M4 single-raised pots as the preflop raiser
  "cbet-why-and-when": {
    summary: "Zašto preflop raiser tako često beta flop i kako prednost raspona i prednost u nutsu odlučuju između malog beta, velikog beta i checka.",
    goals: [
      "Objasni zašto je raiserov raspon na flopu obično jači.",
      "Biraj između malog beta s cijelim rasponom, velikog polariziranog beta i checka.",
      "Objasni zašto check sam po sebi nije gubitak.",
      "Poveži koliko često i koliko velik c-bet radiš s prednošću raspona i prednošću u nutsu.",
    ],
  },
  "cbet-by-texture": {
    summary: "Kako tekstura flopa oblikuje raiserov plan: gdje betati malo i često, gdje veliko ili checkati i zašto su boardovi s asom poseban slučaj.",
    goals: [
      "Betaj malo i često na visokim, suhim i uparenim flopovima.",
      "Checkaj češće i betaj veće na srednjim, povezanim flopovima.",
      "Igraj jednobojne flopove malim betovima i češćim checkom.",
      "Objasni zašto zaštita malo vrijedi na statičnim boardovima, a puno na dinamičnim.",
    ],
  },
  "hand-classes-on-the-flop": {
    summary: "Kako na flopu razvrstati ruke na value, tanki value i zaštitu, drawove i air te koje od njih betaju, a koje checkaju.",
    goals: [
      "Imenuj klasu ruke na flopu: value, tanki value, draw ili air.",
      "Betaj jake ruke da gradiš pot, a drawove zbog fold equityja i equityja.",
      "Checkaj srednje ruke koje se boje check-raisea.",
      "Odluči kad air beta, kad odustaje, a kad čeka turn.",
    ],
  },
  "oop-as-the-raiser": {
    summary: "Zašto preflop raiser izvan pozicije beta rjeđe i kako raspon s kojim checka održati dovoljno jakim da se može braniti.",
    goals: [
      "Objasni zašto raiser izvan pozicije realizira manje equityja i rjeđe beta.",
      "Zadrži nekoliko jakih ruku u rasponu s kojim checkaš.",
      "Betaj polariziraniji raspon kad betaš izvan pozicije.",
      "Primijeni to na small blind protiv big blinda i na rana sjedala protiv callera na buttonu.",
    ],
  },
  "checking-back-and-delayed-cbets": {
    summary: "Kad je check iza na flopu bolji od beta, kako betati turn nakon tog checka i kad slowplay jake ruke ima smisla.",
    goals: [
      "Odaberi ruke koje prolaze bolje s checkom iza na flopu.",
      "Betaj turn kad caller ponovno checka i pokaže ograničen raspon.",
      "Slowplayaj samo kad je board statičan, a protivnikov raspon slab.",
      "Protiv pasivnih protivnika jake ruke igraj brzo.",
    ],
  },
  "facing-a-check-raise": {
    summary: "Kako odgovoriti kad tvoj c-bet na flopu dobije check-raise: koliki dio raspona nastavlja, koje ruke zadržati i kad foldati češće.",
    goals: [
      "Nastavi s dovoljno raspona da check-raise ne pobjeđuje automatski.",
      "Kad nastavljaš, biraj drawove i ruke s equityjem prije tankih gotovih ruku.",
      "Shvati minimalnu obranu (MDF) kao okvirnu smjernicu, a ne kao pravilo.",
      "Foldaj češće protiv igrača koji check-raiseaju samo s jakim rukama.",
    ],
  },

  // ---- M5 single-raised pots as the caller
  "defending-vs-cbets": {
    summary: "Kako se kao caller braniti od c-beta na flopu: koliko široko protiv malih i velikih betova te koje ruke foldaju, callaju ili raiseaju.",
    goals: [
      "Brani se šire protiv malih c-betova, a uže protiv velikih.",
      "Zadrži ruke s backdoor drawovima i foldaj ruke bez equityja.",
      "Biraj fold, call ili raise prema klasi ruke.",
      "Provjeri call i prema cijeni i prema equityju koji će tvoja ruka realizirati.",
    ],
  },
  "check-raising": {
    summary: "Kako složiti raspon za check-raise na flopu od jakih ruku i dobrih drawova i kako prepoznati boardove koji mu odgovaraju.",
    goals: [
      "Složi raspon za check-raise od jakih value ruku i dobrih drawova.",
      "Pronađi boardove na kojima caller ima više setova i dvaju parova.",
      "Koristi drawove za raise jer zadržavaju equity kad dobiju call.",
      "Check-raiseaj češće protiv malih c-betova.",
    ],
  },
  "floating-and-stabbing-ip": {
    summary: "Kako u poziciji callati c-bet s rukama koje mogu pobijediti kasnije i kako betati kad ti raiser checka.",
    goals: [
      "Callaj u poziciji s rukama koje se mogu popraviti ili kasnije uzeti pot.",
      "Objasni zašto raiserov check ograničava njegov raspon.",
      "Betaj malo sa širokim rasponom kad ti raiser checka.",
      "Zadrži jake ruke među tim betovima da ih je teško napasti.",
    ],
  },
  "probes-and-donk-bets": {
    summary: "Kad caller treba betati prvi u preflop raisera: na kartama koje najjače ruke prebacuju njemu ili nakon što raiser checka iza.",
    goals: [
      "Leadaj na kartama koje tvoj raspon pogađaju puno jače nego raiserov.",
      "Betaj turn nakon što raiser checka iza na flopu i time ograniči svoj raspon.",
      "Odaberi ruke koje više dobivaju leadom nego checkom.",
      "Objasni zašto se lead na flopovima koje raiser dobro pogađa rijetko isplati.",
    ],
  },
  "facing-turn-barrels": {
    summary: "Kako odlučiti koje ruke nastavljaju callati kad raiser ponovno beta turn, prema veličini beta, drawovima i tome koliko mu je raspon ograničen.",
    goals: [
      "Foldaj češće što je bet na turnu veći.",
      "Biraj callove s dodatnim drawovima i šansama za dva para.",
      "Objasni kako ograničen raspon niske parove pretvara u call.",
      "Biraj callove po tome kako se ruka igra na riveru, a ne samo po paru koji drži.",
    ],
  },
  "bb-vs-btn-blueprint": {
    summary: "Najčešći pot s jednim raiseom, big blind protiv opena s buttona, odigran od flopa do rivera sa svime iz prethodna dva modula.",
    goals: [
      "Isplaniraj obranu big blinda protiv opena s buttona od flopa do rivera.",
      "Spoji ideje raisera i callera u jednoj ruci.",
      "Rješavaj izmiješane odluke na turnu i riveru u istom treningu.",
      "Pronađi i ponovno odigraj svoje ruke big blind protiv buttona.",
    ],
  },

  // ---- M6 3-bet and 4-bet pots
  "spr-and-commitment": {
    summary: "Što je omjer stacka i pota (SPR), kako ga izračunati i kako on određuje koje su ruke spremne uložiti sve čipove.",
    goals: [
      "Izračunaj SPR na flopu iz pota i stackova.",
      "Imenuj ruke koje uz nizak SPR igraju za cijeli stack.",
      "Objasni kako opasni boardovi i dublji stackovi slabe ruke s jednim parom.",
      "Usporedi kako se 3-bet pot igra na 100 bb i na 200 bb.",
      "Izbjegavaj fold nakon što je veći dio stacka već uložen.",
    ],
  },
  "cbetting-as-the-3bettor": {
    summary: "Kako igrač koji je 3-betao beta flop u poziciji i izvan nje te kako nizak SPR mijenja koje ruke betaju i koliko veliko.",
    goals: [
      "Betaj malo i često u poziciji na visokim i uparenim flopovima te flopovima s asom.",
      "Budi oprezniji na srednjim, povezanim flopovima.",
      "Checkaj češće izvan pozicije, posebno na niskim boardovima.",
      "Objasni zašto se veliki parovi uz nizak SPR ponašaju kao vrlo jake ruke.",
      "Betaj veće s jakim rukama koje su ranjive.",
    ],
  },
  "playing-3bp-as-the-caller": {
    summary: "Kako igrati 3-bet pot kao caller: obrana od malih c-betova, check-raise na niskim povezanim boardovima i hvatanje blefova.",
    goals: [
      "Objasni zašto je callerov raspon pun srednjih parova i suited ruku.",
      "Brani se od malih c-betova s dovoljno raspona.",
      "Check-raiseaj na niskim, povezanim boardovima koje promaši igrač koji je 3-betao.",
      "Hvataj blefove na riveru protiv ograničenih linija.",
    ],
  },
  "range-splitting-ip-vs-checks-3bp": {
    summary: "Kako u poziciji podijeliti raspon na mali bet, veliki bet i check nakon što igrač izvan pozicije checka u 3-bet potu.",
    goals: [
      "Podijeli raspon u poziciji na male betove, velike betove i checkove nakon checka u 3-bet potu.",
      "Napravi podjelu i kad si ti 3-betao i kad si callao 3-bet pa protivnik checka.",
      "Predvidi kako se podjela mijenja s teksturom boarda.",
      "Predvidi kako se podjela mijenja s dubljim stackovima i višim SPR-om.",
      "Objasni čemu služi svaka opcija: value, oduzimanje equityja, fold equity, kontrola pota ili zaštita.",
    ],
  },
  "3bp-turn-and-river": {
    summary: "Kako se igraju zadnja dva streeta 3-bet pota s kratkim stackovima: barrel ili odustajanje, veličine za all-in i callanje ograničenih raspona.",
    goals: [
      "Odluči na turnu hoćeš li barrelati ili odustati, znajući da se tu obično odlučuju stackovi.",
      "Odaberi veličine na turnu i riveru tako da stackovi uđu u pot do rivera.",
      "Biraj prave blefove za polarizirane all-ine.",
      "Hvataj blefove protiv ograničenih raspona i foldaj na all-ine s premalo blefova.",
    ],
  },
  "four-bet-pots": {
    summary: "Kako se igraju 4-bet potovi s vrlo malo novca iza: mali c-betovi, izbor između all-ina i folda te koje ruke mogu callati 4-bet.",
    goals: [
      "Izračunaj SPR u 4-bet potu.",
      "Biraj između malog c-beta, all-ina i folda.",
      "Odaberi ruke koje mogu callati 4-bet i dobro se igraju nakon flopa.",
      "Objasni zašto su ovdje equity i vezanost uz pot važniji od pozicije.",
    ],
  },

  // ---- M7 the turn
  "turn-card-classes": {
    summary: "Kako karte na turnu razvrstati na overcarde, karte koje dovršavaju drawove, karte koje uparuju board i prazne karte te kome koja pomaže.",
    goals: [
      "Razvrstaj kartu na turnu kao overcard, kartu koja dovršava draw, kartu koja uparuje board ili praznu kartu.",
      "Reci kojem igraču karta na turnu pomaže s obzirom na dosadašnju akciju.",
      "Objasni zašto board postaje stabilniji i zašto je kontrola pota važnija.",
      "Prati kako karta na turnu mijenja prednost raspona i prednost u nutsu.",
    ],
  },
  "double-barreling": {
    summary: "Kad kao preflop raiser ponovno betati turn: koje value ruke i blefovi nastavljaju betati, a kad odustati.",
    goals: [
      "Ponovno betaj turn s value rukama i blefovima s equityjem kad ti karta pomaže.",
      "Biraj blefove za drugi barrel koji se mogu popraviti ili blokiraju callerove najbolje ruke.",
      "Odustani na kartama na turnu koje pomažu calleru.",
      "Isplaniraj river prije nego što betaš turn.",
    ],
  },
  "turn-sizing-and-overbets": {
    summary: "Koliko velik bet raditi na turnu, kad je overbet pravi izbor i koje srednje ruke radije trebaju checkati.",
    goals: [
      "Overbetaj kad imaš prednost u nutsu, a protivnikov raspon je ograničen.",
      "Biraj overbet blefove koji blokiraju ruke koje callaju, a ne diraju ruke koje foldaju.",
      "Checkaj srednje ruke da držiš pot pod kontrolom.",
      "Uskladi veličinu na turnu s oblikom raspona s kojim betaš.",
    ],
  },
  "turn-after-flop-checks-through": {
    summary: "Kako igrati turn nakon što su oba igrača checkala flop: lead izvan pozicije, bet u poziciji i obrana od obojega.",
    goals: [
      "Objasni kako checkani flop ograničava oba raspona, svaki na svoj način.",
      "Leadaj turn izvan pozicije kad karta ide u prilog tvom rasponu.",
      "Betaj turn u poziciji nakon što je flop prošao check-check.",
      "Brani se razumno od leadova i odgođenih betova na turnu.",
    ],
  },

  // ---- M8 the river
  "river-polarisation": {
    summary: "Zašto se rasponi za bet na riveru dijele na jake ruke i blefove i koliko često value bet mora pobijediti kad dobije call.",
    goals: [
      "Objasni zašto value bet mora pobijediti više od pola puta kad dobije call.",
      "Objasni zašto se rasponi na riveru dijele na jake ruke i blefove.",
      "Checkaj srednje ruke koje niti dobivaju call od slabijih niti tjeraju jače na fold.",
      "Pronađi situacije na riveru u kojima je bet bolji od checka.",
    ],
  },
  "thin-value": {
    summary: "Kako na riveru betati za value sa skromnim rukama, koliko malo betati i kako prepoznati kad je bet postao pretanak.",
    goals: [
      "Pronađi betove na riveru koji pobjeđuju dovoljno ruku koje callaju.",
      "Radi male tanke value betove.",
      "Prepoznaj kad rizik od raisea tanki bet pretvara u gubitan.",
      "Betaj tanje protiv pasivnih igrača, a manje tanko protiv onih koji često raiseaju.",
      "Prestani checkati iza s jakim rukama koje trebaju betati.",
    ],
  },
  "choosing-bluffs-blockers": {
    summary: "Kako birati blefove na riveru prema kartama koje držiš: blokiraj ruke koje callaju i ne diraj ruke koje foldaju.",
    goals: [
      "Biraj blefove koji drže karte iz protivnikovih ruku za call.",
      "Izbjegavaj blefove koji drže karte iz protivnikovih ruku za fold.",
      "Objasni zašto promašeni flush draw može biti slabiji blef nego što izgleda.",
      "Odluči koji promašeni drawovi betaju, a koji odustaju.",
    ],
  },
  "bluff-catching": {
    summary: "Kako odlučiti hoćeš li callati bet na riveru s rukom koja pobjeđuje samo blefove, brojeći value ruke, blefove i karte koje držiš.",
    goals: [
      "Prebroji protivnikove value ruke i blefove za liniju koju je odigrao.",
      "Provjeri kako tvoje karte mijenjaju te brojeve.",
      "Koristi minimalnu obranu (MDF) kao polazište, a ne kao pravilo.",
      "Foldaj češće na velike betove na riveru od igrača koji rijetko blefiraju.",
      "Primijeni istu metodu u potovima s jednim raiseom, 3-bet potovima i limpanim potovima.",
    ],
  },
  "river-sizing": {
    summary: "Kako veličinu beta na riveru izabrati prema obliku raspona: malo s tankim valueom, veliko ili overbet s nutsom i blefovima.",
    goals: [
      "Betaj malo kad tvoj raspon ima mnogo tankih value ruku.",
      "Betaj veliko ili overbetaj kad imaš prednost u nutsu i dovoljno blefova.",
      "Objasni zašto nuts ponekad beta malo.",
      "Uskladi veličinu s rukama od kojih želiš call.",
    ],
  },
  "facing-river-raises": {
    summary: "Kako odgovoriti na raise ili lead na riveru i zašto većina igrača river raisea s jakim rukama puno češće nego s blefovima.",
    goals: [
      "Shvati raise na riveru kao obično jaku ruku, posebno u live igri.",
      "Odluči koje ruke još mogu callati raise na riveru.",
      "Raiseaj ili callaj češće protiv širokih leadova na riveru nakon checkanog turna.",
      "Razlikuj kad fold iskorištava populaciju, a kad predaje previše.",
    ],
  },

  // ---- M9 multiway
  "multiway-principles": {
    summary: "Što se mijenja kad flop vide tri ili više igrača: obrana se dijeli, blefovi rjeđe prolaze, a jake ruke vrijede više.",
    goals: [
      "Objasni zašto svaki dodatni protivnik čini jaku ruku za stolom vjerojatnijom.",
      "Podijeli teret obrane s ostalim igračima koji su još u ruci.",
      "Betaj uže i manje te rjeđe blefiraj.",
      "Biraj ruke koje mogu složiti nuts prije dominiranih drawova.",
      "Izbjegavaj slowplay koji nekolicini protivnika dopušta da te sustignu.",
    ],
  },
  "multiway-as-the-raiser": {
    summary: "Kako preflop raiser beta flop protiv dvojice ili više protivnika: na kojim boardovima, s kojim rukama i koliko veliko.",
    goals: [
      "Betaj jake ruke i jake drawove protiv više igrača.",
      "Checkaj većinu ruku srednje jačine.",
      "Betaj manje nego u heads-up potu.",
      "Prilagodi plan tome koliko su široki ili uski rasponi callera.",
    ],
  },
  "multiway-defence": {
    summary: "Kako se braniti od beta kad iza tebe još ima igrača koji trebaju odigrati i kad sam betati prvi u više protivnika.",
    goals: [
      "Brani se uže kad igrači iza tebe još mogu raiseati.",
      "Callaj šire kad si zadnji na potezu.",
      "Podijeli teret obrane s ostalim igračima u potu.",
      "Betaj prvi u više protivnika kad board ide u prilog tvom rasponu.",
    ],
  },
  "multiway-preflop-choices": {
    summary: "Koji preflop izbori pot drže heads-up, a koji pozivaju više igrača te koje ruke odgovaraju jednima, a koje drugima.",
    goals: [
      "Biraj između squeezea, izolacije i calla da usmjeriš koliko igrača vidi flop.",
      "Overcallaj sa suited rukama i parovima koji se dobro igraju multiway.",
      "Izbjegavaj multiway potove s offsuit broadway rukama.",
      "Prepoznaj kako limpovi i straddleovi stvaraju multiway potove.",
    ],
  },

  // ---- M10 live cash, deep stacks, straddles, exploits
  "live-game-dynamics": {
    summary: "Po čemu se live cash razlikuje od online igre: veći openi, duboki i neravnomjerni stackovi, rake, manje ruku na sat i praćenje pota.",
    goals: [
      "Prilagodi se većim live openima te dubokim i neravnomjernim stackovima.",
      "Uračunaj rake i sporiji tempo kad biraš situacije.",
      "Prati pot u čipovima na svakom streetu.",
      "Odluči kad, ako ikad, pokazati blef.",
    ],
  },
  "straddle-preflop": {
    summary: "Kako straddle mijenja pot, pozicije i svaki preflop raspon, od opena do blindova i obrane samog straddlera.",
    goals: [
      "Objasni kako straddle mijenja veličinu pota i tko prije flopa igra zadnji.",
      "Prilagodi raspone za open i 3-bet sjedalo po sjedalo u igri sa straddleom.",
      "Igraj small blind uže i brani straddle kao dublji big blind.",
      "Očekuj više multiway potova kad postoji straddle.",
    ],
  },
  "straddle-postflop-low-spr": {
    summary: "Kako veći preflop potovi u igrama sa straddleom snižavaju SPR i što to znači za vezanost uz pot, drawove i multiway igru.",
    goals: [
      "Izračunaj SPR u potu sa straddleom.",
      "Uz niži SPR češće idi do kraja s top parom i overparovima.",
      "Objasni zašto drawovi gube implied odds kad su stackovi kratki u odnosu na pot.",
      "Planiraj multiway potove sa straddleom imajući na umu vezanost uz pot.",
    ],
  },
  "deep-stacks-200bb": {
    summary: "Kako se igra mijenja na 200 big blindova: koje ruke dobivaju ili gube prije flopa, veći betovi nakon njega i zašto jedan par vrijedi manje.",
    goals: [
      "Kad si dubok, otvaraj i brani više suited, povezanih ruku i manje offsuit broadway ruku.",
      "Objasni zašto su potencijal za nuts i implied odds važniji s dubokim stackovima.",
      "Cijeni ruke s jednim parom manje uz viši SPR.",
      "Koristi veće betove da planovi kroz više streetova i dalje dovedu stackove u pot.",
    ],
  },
  "population-exploits": {
    summary: "Kako krenuti od uravnotežene strategije, uočiti što populacija igrača radi previše ili premalo i prilagoditi se bez novih leakova.",
    goals: [
      "Kreni od ravnoteže kao polazišta prije bilo kakve prilagodbe.",
      "Uoči gdje igrači betaju, callaju ili blefiraju previše ili premalo.",
      "Primijeni uobičajene protumjere na niskim ulozima, poput češćeg folda na velike betove na riveru.",
      "Prati prilagodbu kroz kasnije streetove da ne postane novi leak.",
    ],
  },
  "player-profiles": {
    summary: "Kako po statistikama prepoznati calling stationa, nita, manijaka i solidne regulare te glavnu prilagodbu protiv svakoga od njih.",
    goals: [
      "Prepoznaj calling stationa, nita, manijaka, TAG-a i LAG-a po statistikama.",
      "Protiv calling stationa betaj više za value i manje blefiraj.",
      "Češće kradi blindove nitovima i poštuj njihovu agresiju.",
      "Protiv manijaka callaj šire do kraja i češće postavljaj zamke.",
      "Protiv solidnih regulara ostani blizu osnovne strategije.",
    ],
  },
};

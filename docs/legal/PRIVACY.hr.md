# Pravila privatnosti

> **Nacrt - još nije na snazi; čeka pregled vlasnika i pravnika.**
> Tekst je napisan prema tome kako Rail stvarno sprema i prenosi podatke (vidi
> `docs/DATABASE.md` i `docs/RAIL-PLAN.md`), kao polazište za pregled. Nije
> pravni savjet. Sve u `[uglatim zagradama]` vlasnik treba popuniti ili
> potvrditi.

Zadnja izmjena: [datum stupanja na snagu]

## 1. Tko je odgovoran

Rail ("mi") vodi [VLASNIK: pravni naziv osobe ili tvrtke], [VLASNIK: adresa],
[VLASNIK: OIB / matični broj]. Mi smo voditelj obrade osobnih podataka
opisanih ovdje.

Kontakt za sve u vezi s tvojim podacima: [VLASNIK: e-adresa za privatnost].
[VLASNIK / pravnik: treba li imenovati službenika za zaštitu podataka; ako
treba, njegov kontakt.]

## 2. Ukratko

- Konverter i replayer možeš koristiti bez računa. **Datoteka koju ubaciš u
  web konverter čita se u tvom pregledniku i ne napušta ga dok je ne
  spremiš** na svoj račun.
- S računom spremamo ono što spremiš: tvoje ruke, ono što Rail iz njih
  izračuna, bilješke, chartove i postavke te ono što objaviš na forumu.
- Ne prodajemo podatke, ne prikazujemo oglase i ne koristimo kolačiće za
  analitiku ni praćenje.
- Desktop aplikacija čuva tvoje ruke na tvom računalu; na račun ih šalje samo
  kad se prijaviš i uključiš sinkronizaciju.
- Sve svoje podatke možeš sam preuzeti i račun sam obrisati, u Postavkama, u
  bilo kojem trenutku.

## 3. Što obrađujemo i zašto

### 3.1 Tvoj račun

Tvoja e-adresa, lozinka (pružatelj prijave čuva je samo kao hash), korisničko
ime, kad si se registrirao i zadnji put prijavio, te sigurnosni zapisi prijava
(vrijeme, IP adresa, preglednik). Trebaju nam da bi imao račun i da bi bio
siguran (čl. 6. st. 1. t. (b) GDPR-a: ugovor; t. (f): sigurnost).

Tvoje **korisničko ime, karma i datum pridruživanja su javni** (stranica
profila), kao i sve što objaviš na forumu.

### 3.2 Tvoje ruke

- **Web konverter** pretvara u tvom pregledniku. Ništa se ne šalje dok ne
  odabereš spremanje na račun.
- **Kad spremiš**, svaku ruku spremamo kao strukturirani dokument (PHF,
  Railov format ruke), polja za pretragu izvedena iz njega i naziv datoteke
  iz koje je došla; za ruke spremljene iz jednog pokretanja konvertera i
  pretvoreni te izvorni tekst povijesti ruke. Skupni prijenos sprema samo
  strukturirani dokument.
- **Izvorne datoteke** skupnog prijenosa spremaju se samo ako za taj prijenos
  označiš "Zadrži i izvorne datoteke" (komprimirane, u privatnom spremištu
  koje čita samo tvoj račun).
- **Desktop aplikacija** sprema ruke u bazu na tvom računalu. Kad si prijavljen
  i sinkronizacija je uključena, šalje strukturirani dokument i statistiku po
  sjedalu za svaku ruku - nikad izvorne datoteke ni njihov tekst.
- **Povijesti ruku koje se nisu dale pretvoriti**: kad na webu spremiš
  ubačene datoteke, ruke koje Rail nije mogao pročitati čuvaju se s razlogom,
  čitljive samo tebi i nama, da bismo dodali njihovu podršku (čl. 6. st. 1.
  t. (f): poboljšanje konvertera). Desktop aplikacija takav uzorak šalje samo
  uz tvoj pristanak, i to prethodno anonimiziran na tvom računalu (imena
  igrača, stolova i brojevi ruku zamijenjeni).

**Drugi igrači u tvojim rukama.** Povijesti ruku sadrže imena igrača protiv
kojih si igrao. Spremamo ih kao dio tvojih ruku, čitljive samo tebi, jer o
njima ovise statistika, bilješke i analiza koje tražiš (čl. 6. st. 1. t. (f)).
Kad ruku **podijeliš**, imena protivnika su po zadanome skrivena; kad je
**objaviš** na forumu, svako se ime zamjenjuje (Hero, Villain1, ...) osim ako
odabereš drukčije, a stol, broj ruke i točno vrijeme uvijek se uklanjaju.
Podatke o protivnicima nikad ne prenosimo s jednog računa na drugi.

### 3.3 Što Rail izračuna i što dodaš

Statistika, all-in EV, analiza i ocjene tvojih odluka, pregledi sesija,
sažeci propusta, vježbe i odgovori u treneru, napredak u tečaju, planovi
učenja, tvoji preflop chartovi, isplate turnira koje upišeš, bilješke o
igračima, HUD rasporedi, nazivi tvojih mapa i nazivi računala koja
sinkroniziraju. Spremamo ih da bi radile značajke koje koristiš (čl. 6. st. 1.
t. (b)).

### 3.4 Forum i dijeljenje

Objave, komentari, glasovi, spremljene objave, praćene teme, obavijesti,
ankete, objavljene ruke, poveznice za dijeljenje i prijave koje podneseš.
Objave, komentari, objavljene i podijeljene ruke su **javni** (svakome s
poveznicom ili svakome, kako značajka kaže). Moderacija (uklanjanje sadržaja,
zabrane, prijave) vodi zapis o tome što je učinjeno i zašto, radi sigurnosti
foruma i rješavanja pritužbi i pravnih zahtjeva (čl. 6. st. 1. t. (f)).

### 3.5 Plaćanje [vrijedi kad plaćeni planovi krenu]

Plaćanja obrađuje Stripe. Podatke tvoje kartice nikad ne vidimo ni ne
spremamo. Spremamo tvoj plan, njegov status i datum obnove te Stripeove
referentne brojeve za tebe i tvoju pretplatu (čl. 6. st. 1. t. (b)). Tvoj
zapis kupca u Stripeu i njegovi računi porezni su zapisi: čuvaju se koliko god
porezni i računovodstveni propisi traže (čl. 6. st. 1. t. (c)), i nakon što
obrišeš račun.

### 3.6 Tehnički podaci

Naši pružatelji hostinga bilježe zahtjeve (IP adresa, preglednik, vrijeme,
tražena adresa) da bi usluga radila i bila zaštićena. Po računu vodimo
brojače za sprječavanje zloupotrebe (npr. koliko ruku račun smije spremiti u
deset minuta); brišu se nakon dva dana. Registraciju i prijavu štiti
Cloudflare Turnstile, koji provjerava prijavljuje li se osoba, a ne skripta
(čl. 6. st. 1. t. (f): sigurnost).

### 3.7 U tvom pregledniku

Koristimo samo ono što je stranici potrebno za rad: kolačić koji te drži
prijavljenim, kolačić s jezikom koji si odabrao i lokalnu pohranu preglednika
za stvari poput nedovršene ruke koju unosiš, mjesta na kojem je prekinut
prijenos i spremljenog napretka u tečaju. **Nema kolačića za oglašavanje,
analitiku ili praćenje**, pa ne tražimo pristanak za kolačiće. Turnstile, na
obrascu za prijavu, može postaviti ono što mu treba za provjeru.

### 3.8 Desktop aplikacija

- Lokalni podaci: tvoje ruke, statistika, postavke, HUD rasporedi i zapisnici
  su u mapama aplikacije na tvom računalu (Postavke -> Račun -> Tvoji podaci
  pokazuje gdje). Ostaju ondje bez obzira jesi li prijavljen.
- Kad si prijavljen: sesija se čuva u sistemskom privjesku ključeva;
  aplikacija sinkronizira kako je opisano u 3.2, te tvoje HUD rasporede.
- Aplikacija s naših poslužitelja preuzima popis soba (`sites.json`) i
  biblioteku solvera, koji pritom vide tvoju IP adresu kao i kod svakog
  preuzimanja.
- Nema telemetrije. [Ako se doda prijava rušenja, bit će uz pristanak, a ovaj
  će odjeljak reći što šalje.]
- **HUD** radi samo u poker sobama čija objavljena pravila to dopuštaju (popis
  se provjerava prije svakog izdanja), samo s tvojim rukama i statistikom, i
  nikad ne daje savjete tijekom igre.

## 4. Tko prima tvoje podatke

Za rad Raila koristimo ove pružatelje (izvršitelje obrade), uz ugovore o
obradi podataka:

| Pružatelj | Za što | Gdje |
| --- | --- | --- |
| Supabase | Baza, prijava, spremište datoteka, funkcije na poslužitelju | Podaci se čuvaju u EU (Frankfurt, Njemačka). Supabase Inc. je u SAD-u [pravnik: potvrditi osnovu prijenosa - standardne ugovorne klauzule EU / Okvir EU-SAD za privatnost podataka] |
| Vercel | Hosting web stranice | Globalna mreža; Vercel Inc., SAD [pravnik: kao gore] |
| Stripe [kad plaćeni planovi krenu] | Plaćanja, pretplate, porez | Stripe Payments Europe Ltd., Irska (i njegova grupa) |
| Resend | Slanje e-pošte vezane uz račun (potvrda, nova lozinka) | Resend, SAD [pravnik: kao gore] |
| Cloudflare | Turnstile, provjera pri prijavi | Cloudflare Inc., SAD [pravnik: kao gore] |
| [GitHub] | [Distribucija desktop aplikacije i njezinih ažuriranja] | [GitHub Inc., SAD] |

Osobne podatke ne prodajemo ni ne iznajmljujemo i ne dijelimo ih radi
oglašavanja. Tijelima ih otkrivamo samo kad to zakon traži.

## 5. Koliko dugo ih čuvamo

| Podaci | Čuvanje |
| --- | --- |
| Tvoj račun i sve u njemu | Dok ga ne obrišeš (ili ne obrišeš stavku) |
| Sigurnosne kopije pružatelja baze | Do [VLASNIK: razdoblje sigurnosnih kopija / povrata u trenutak za plan, npr. 7 dana] nakon brisanja |
| Zapisnici poslužitelja i prijava | [VLASNIK: potvrditi čuvanje zapisnika kod pružatelja, npr. do 30 dana] |
| Brojači zloupotrebe | 2 dana |
| Korisničko ime obrisanog računa | Rezervirano (nitko ga ne može uzeti) 1 godinu, zatim se oslobađa |
| Zapis da je brisanje provedeno (id računa i vremena, bez sadržaja) | 30 dana |
| Zapisi moderacije | [VLASNIK: odlučiti, npr. 2 godine]; riječi sadržaja obrisanog računa uklanjaju se iz njih pri brisanju |
| Računi i zapisi o plaćanjima | [pravnik: koliko traže hrvatski porezni i računovodstveni propisi, npr. 11 godina] |

## 6. Tvoja prava

Imaš pravo na pristup svojim podacima i na njihovo dobivanje u prenosivom
obliku, na ispravak, na brisanje, na ograničenje obrade i prigovor obradi
koja se temelji na našem legitimnom interesu te na povlačenje privole u bilo
kojem trenutku (čl. 15.-22. GDPR-a).

- **Pristup i prenosivost**: Postavke -> Tvoji podaci -> "Preuzmi moje
  podatke" daje ZIP sa svime što o tvom računu čuvamo, u JSON-u, s rukama u
  PHF-u, izrađen u tvom pregledniku. Zapisi moderacije koji imenuju druge ljude
  nisu u njemu; svoje nam zatraži.
- **Ispravak**: korisničko ime i lozinka u Postavkama; ruke možeš obrisati iz
  biblioteke.
- **Brisanje**: Postavke -> Brisanje računa (vidi odjeljak 7).
- **Pritužbe**: možeš se obratiti Agenciji za zaštitu osobnih podataka (AZOP,
  azop.hr) ili nadzornom tijelu u zemlji u kojoj živiš. Voljeli bismo da se
  najprije javiš nama: [VLASNIK: e-adresa za privatnost].

## 7. Brisanje računa

Postavke -> Brisanje računa. Potvrdiš korisničkim imenom i lozinkom i brisanje
odmah počinje (nema razdoblja čekanja - zato najprije preuzmi podatke ako ih
želiš):

- tvoja pretplata odmah se otkazuje (tvoj zapis kupca i računi u Stripeu
  ostaju, kao porezni zapisi - odjeljak 3.5);
- brišu se tvoje ruke, statistika, analiza, bilješke, chartovi, postavke, HUD
  rasporedi, izvori, dijeljenja i sačuvane izvorne datoteke;
- na forumu se brišu objave na koje nitko nije odgovorio i tvoje objavljene
  ruke; objava na koju su drugi odgovorili ostaje kao "[deleted]" bez tvojih
  riječi i imena, a tvoji komentari postaju oznake "obrisano", da odgovori
  drugih i dalje imaju smisla; tvoji glasovi se uklanjaju; prijave koje si
  podnio ostaju moderatorima bez tvog imena i tvojih riječi;
- tvoje korisničko ime ostaje rezervirano godinu dana da se nitko ne može
  predstavljati kao ti.

Do čega brisanje **ne** dopire: podaci desktop aplikacije na tvom računalu.
Da ih ukloniš, zatvori Rail (i iz trake sustava), deinstaliraj ga i obriši
njegove mape: na macOS-u `~/Library/Application Support/app.rail.desktop` i
`~/Library/Logs/app.rail.desktop`; na Windowsima
`%LOCALAPPDATA%\app.rail.desktop` i `%APPDATA%\app.rail.desktop`. Odjava iz
aplikacije uklanja njezinu sesiju iz privjeska ključeva. Kopije u sigurnosnim
kopijama pružatelja istječu kako je navedeno u odjeljku 5.

## 8. Sigurnost

Podaci svakog računa odvojeni su u samoj bazi (sigurnost na razini retka,
testirana pri svakoj promjeni), veze su šifrirane, lozinke hashira pružatelj
prijave, a administrativni pristup koriste samo dvije usko ograničene funkcije
na poslužitelju (prijava desktop aplikacije i brisanje računa).

## 9. Dob

Rail je za osobe od 18 i više godina [VLASNIK: potvrditi; sadržaj o pokeru].
Svjesno ne čuvamo podatke mlađih osoba; javi nam i obrisat ćemo ih.

## 10. Izmjene

Izmjene ovih pravila najavit ćemo na stranici, a važne i e-poštom, prije nego
što stupe na snagu.

## 11. Kontakt

[VLASNIK: pravni naziv], [VLASNIK: adresa], [VLASNIK: e-adresa za privatnost].

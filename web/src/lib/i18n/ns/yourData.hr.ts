import type { Dict } from "../types";

/** Tvoji podaci (Rail R6.5): izvoz i brisanje računa. Same shape as `account.en.ts`. */

const num = (value: number) => value.toLocaleString("hr-HR");

export const yourDataHr: Dict["yourData"] = {
  data: {
    heading: "Tvoji podaci",
    intro:
      "Preuzmi sve što Rail čuva o tvom računu u jednoj ZIP datoteci: profil i plan, svaku ruku kako je spremljena, bilješke, chartove, postavke i HUD rasporede, dijeljenja, ono što si pisao na forumu i ostalo. Datoteka nastaje ovdje, u tvom pregledniku, stranicu po stranicu; na našim poslužiteljima ne ostaje nikakva kopija.",
    derived: "Uključi i statistiku i analizu (Rail ih izračunava iz tvojih ruku; otprilike tri puta veća datoteka i četiri puta dulje čekanje)",
    originals: "Uključi izvorne datoteke koje si sačuvao pri prijenosu, ako ih ima (mogu biti velike)",
    start: "Preuzmi moje podatke",
    cancel: "Odustani",
    counting: "Brojim tvoje podatke…",
    pickFile: "Odaberi gdje spremiti datoteku…",
    progressHands: (done: number, total: number) => `Ruke: ${num(done)} od ${num(total)}`,
    progressSections: (done: number, total: number) => `Ostali podaci: ${num(done)} od ${num(total)} tablica`,
    progressOriginals: (done: number, total: number) => `Izvorne datoteke: ${num(done)} od ${num(total)}`,
    written: (size: string) => `Dosad zapisano ${size}`,
    finishing: "Dovršavam datoteku…",
    done: (name: string, size: string) => `Izvoz je spreman: ${name} (${size}).`,
    saveAgain: "Spremi datoteku",
    savedToDisk: "Zapisan je u datoteku koju si odabrao.",
    cancelled: "Izvoz je prekinut. Ništa nije sačuvano.",
    failed: (reason: string) => `Izvoz je stao: ${reason}. Pokušaj ponovno; kreće ispočetka.`,
    rateLimited: "Danas si pokrenuo 10 izvoza. Pokušaj ponovno sutra.",
    bigHint:
      "Velika biblioteka traje neko vrijeme (nekoliko minuta na 100 000 ruku). U Chromeu i Edgeu najprije odabereš datoteku pa se zapisuje dok nastaje; u ostalim preglednicima preuzima se kad je gotova. Ne zatvaraj ovu karticu.",
    formats:
      "Strojno čitljivo: JSON i NDJSON (jedan JSON objekt po retku), ruke u PHF-u, JSON formatu ruke koji Rail svugdje koristi. README unutra objašnjava svaku datoteku.",
  },

  delete: {
    heading: "Brisanje računa",
    intro: "Ovo odmah briše tvoj račun i sve u njemu. Ne može se poništiti.",
    whatHeading: "Što se događa",
    what: [
      "Brišu se tvoje ruke, statistika, analiza, bilješke, chartovi, postavke, HUD rasporedi i izvori, te izvorne datoteke koje si sačuvao.",
      "Tvoje poveznice za dijeljenje prestaju raditi.",
      "Forum: brišu se tvoje objave na koje nitko nije odgovorio i tvoje objavljene ruke. Objava na koju su drugi odgovorili ostaje kao „[deleted]”, bez tvojih riječi i tvog imena, da njihovi odgovori i dalje imaju smisla; tvoji komentari na isti način postaju oznake „obrisano”. Tvoji glasovi se uklanjaju.",
      "Plaćena pretplata najprije se otkazuje.",
      "Tvoje korisničko ime ostaje rezervirano godinu dana da se nitko ne može predstavljati kao ti, a onda se oslobađa.",
    ],
    desktopNote:
      "Desktop aplikacija čuva vlastitu kopiju tvojih ruku na tvom računalu. Brisanje računa do nje ne dopire: ukloni je ondje (u aplikaciji, Postavke → Račun objašnjava kako).",
    exportFirst: "Najprije preuzmi svoje podatke",
    confirmLabel: (username: string) => `Upiši svoje korisničko ime, ${username}, za potvrdu`,
    passwordLabel: "Tvoja lozinka",
    passwordHint: "Tražimo je ponovno da nitko drugi ne može obrisati tvoj račun iz preglednika u kojem si ostao prijavljen.",
    submit: "Trajno obriši moj račun",
    deleting: "Brišem tvoj račun… Velika biblioteka može potrajati do sat vremena. Karticu možeš zatvoriti: kad brisanje krene, samo se dovršava.",
    step: {
      billing: "Otkazujem pretplatu…",
      storage: "Brišem spremljene datoteke…",
      content: "Uklanjam tvoj sadržaj s foruma…",
      hands: "Brišem tvoje ruke…",
    },
    resumeNotice: "Brisanje ovog računa je započelo i nije dovršeno. Nastavi ga da se obriše i ostatak.",
    resume: "Nastavi brisanje",
    mismatch: "To nije tvoje korisničko ime. Upiši ga točno kako je prikazano.",
    needPassword: "Upiši lozinku.",
    wrongPassword: "S tom se lozinkom nisi uspio prijaviti. Provjeri je i pokušaj ponovno.",
    errors: {
      not_signed_in: "Sesija ti je istekla. Prijavi se ponovno, pa obriši račun.",
      invalid_request: "Zahtjev nije razumljiv. Osvježi stranicu i pokušaj ponovno.",
      reauth_required: "Prijavi se ponovno (upiši lozinku) da obrišeš račun.",
      confirmation_mismatch: "To nije tvoje korisničko ime. Upiši ga točno kako je prikazano.",
      rate_limited: "Previše pokušaja. Pričekaj sat vremena i pokušaj ponovno.",
      billing_unavailable:
        "Pretplatu trenutno nije bilo moguće otkazati, pa ništa nije obrisano. Pokušaj kasnije ili nam se javi.",
      unavailable: "Nešto je pošlo krivo usput. Ponovnim pokušajem ništa ne gubiš: nastavlja se gdje je stalo.",
    },
    deletedHeading: "Tvoj račun je obrisan",
    deletedBody:
      "Sve je uklonjeno kako je opisano. Hvala što si koristio Rail. Ako koristiš desktop aplikaciju, ukloni i njezine lokalne podatke na računalu.",
  },

  readme: {
    title: "Tvoji podaci iz Raila",
    generated: (at: string, id: string) => `Izvezeno ${at} za račun ${id}.`,
    about:
      "Ova arhiva sadrži podatke koje je Rail u trenutku izvoza čuvao za tvoj račun (članci 15. i 20. GDPR-a). Strojno je čitljiva: JSON datoteke otvori u bilo kojem uređivaču teksta ili ih učitaj bilo kojom JSON bibliotekom.",
    formatsHeading: "Formati",
    formats: [
      "`*.json` - jedan JSON dokument.",
      "`*.ndjson` - JSON po recima: jedan objekt po retku, jedan redak po retku baze. Nazivi stupaca su oni iz baze.",
      "Ruke su podijeljene u datoteke od najviše 2 000 (1 000 sa statistikom i analizom; `hands/hands-00001.ndjson`, ...). Svaki redak ima id ruke, ključ, podrijetlo i vremena, spremljeni standardni ili izvorni tekst ako postoji, te `phf`: ruku kako je spremljena, u PHF-u (Poker Hand Format), JSON formatu koji Rail svugdje koristi. Svaki Railov proizvod ga može ponovno uvesti.",
      "Id-jevi su UUID-ovi i povezuju datoteke (`hand_id` retka statistike je `id` ruke).",
      "Vremena su ISO 8601 u UTC-u. Iznosi su u najmanjoj jedinici ruke (centi za USD) osim ako stupac kaže drukčije.",
    ],
    filesHeading: "Što sadrži",
    filesIntro: "Po jedan redak za svaku vrstu podataka koje Rail čuva o računu (bilješke uz tablice su na engleskom):",
    included: "uključeno",
    inProfile: "u profile.json",
    notIncluded: "nije uključeno",
    reasons: {
      derived: "sažetak koji se ponovno izračunava iz redaka iznad",
      internal: "pogonsko stanje u kojem nema ničeg tvojeg",
      on_request: "zapisi moderacije koji imenuju druge ljude; tvoje nam zatraži",
    },
    optionsHeading: "Opcije ovog izvoza",
    derivedOn: "Retci statistike i analize: uključeni (`hand_stats/`, `analysis/`).",
    derivedOff: "Retci statistike i analize: nisu uključeni (izračunavaju se iz tvojih ruku).",
    originalsOn: "Izvorne datoteke sačuvane pri prijenosu: uključene (`originals/`, gzip, kako su spremljene).",
    originalsOff: "Izvorne datoteke sačuvane pri prijenosu: nisu uključene.",
    manifest: "`manifest.json` navodi svaku datoteku s brojem redaka, brojeve koje je javio poslužitelj i ovaj popis.",
    desktopHeading: "Desktop aplikacija",
    desktop:
      "Desktop aplikacija čuva vlastitu bazu na tvom računalu; ona nije u ovoj arhivi. Njezine sinkronizirane ruke jesu (podrijetlo `desktop`).",
    contact: "Pitanja o tvojim podacima: vidi pravila privatnosti na /privacy.",
  },
};

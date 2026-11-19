import type { Dict } from "../types";

/** `/download` and the bar's "Get the app", Croatian. Same shape as `download.en.ts`. */
export const downloadHr: Dict["download"] = {
  metaTitle: "Preuzmi aplikaciju Rail za macOS i Windows | Rail",
  metaDescription:
    "Rail desktop tracker, HUD i alati za učenje: uvozi svaku ruku dok igraš, prikazuje statistiku uživo na stolu, slaže stolove te donosi solver, nodelockove i trenera na tvoje ruke. Dio Rail Pro plana, za macOS i Windows.",

  getApp: "Preuzmi aplikaciju",
  getAppLabel: "Preuzmi desktop aplikaciju Rail",

  heading: "Rail na tvom računalu",
  lede: "Poker tracker, HUD i alat za učenje koji radi uz tvoju poker sobu. Rail uvozi svaku ruku dok igraš, prikazuje statistiku uživo na stolovima i stavlja solver i trenera uz tvoje ruke, usklađeno s railom na webu.",
  promoAlt:
    "Desktop aplikacija Rail: solver strategija sa zaključanim čvorom, četiri poslagana stola s HUD statistikom i RNG kutijom, ocijenjeni spot u treneru, propusti poredani po izgubljenom EV-u i uvoz novih ruku.",

  features: [
    {
      title: "Uvoz i HUD uživo",
      body: "Jednom pokaži Railu svoju poker sobu. Svaka ruka stiže u biblioteku nekoliko sekundi nakon što završi, uz VPIP, PFR, 3-bet i ostalo iznad svakog sjedala u sobama koje dopuštaju HUD.",
    },
    {
      title: "Poslagani stolovi i RNG",
      body: "Rail slaže tvoje stolove na bilo kojem monitoru, preslaže ih na prečac i drži RNG kutiju u kutu koju možeš pomicati, mijenjati joj veličinu i zaključati.",
    },
    {
      title: "Solver i nodelockovi",
      body: "Otvori bilo koji flop iz solver biblioteke i vidi frekvenciju i EV svake kombinacije. Zaključaj kako igrač stvarno igra i ponovno solvaj spot na svom računalu.",
    },
    {
      title: "Trener",
      body: "Igraj pojedinačne spotove ili cijele ruke protiv solvera, s ocjenom, strategijom i objašnjenjem. „Za tebe“ dijeli spotove u kojima najviše gubiš.",
    },
    {
      title: "Analiza i pregled",
      body: "Propusti poredani po izgubljenom EV-u, EV za svaku opciju u ruci i jedan red filtera kroz Ruke, Izvještaje i Analizu. Označi ruke za pregled i prođi kroz njih u replayeru.",
    },
    {
      title: "Tvoje, i bez interneta",
      body: "Ruke se spremaju na tvoje računalo i rade bez veze. Prijavi se da ih sinkroniziraš s webom i objaviš na forumu.",
    },
  ],

  mac: {
    name: "macOS",
    cta: "Preuzmi za macOS",
    detail: "macOS 11 ili noviji · Apple silicon i Intel · .dmg",
  },
  windows: {
    name: "Windows",
    cta: "Preuzmi za Windows",
    detail: "Windows 10 ili 11 · 64-bitni · instalacija bez administratorskih prava",
  },
  included: "Dio Rail Pro plana. Kad je instalirana, uvoz, biblioteka i replayer rade i bez veze.",

  gate: {
    checking: "Provjeravam tvoj plan…",
    signIn: "Prijavi se za preuzimanje",
    signInReason: "Prijavi se svojim Rail Pro računom za preuzimanje desktop aplikacije.",
    signInDetail: "Desktop aplikacija dolazi uz Rail Pro.",
    proBody: "Tvoj plan ne uključuje desktop aplikaciju. Prijeđi na Pro da je preuzmeš.",
    error: "Nismo uspjeli provjeriti tvoj plan, pa preuzimanje trenutno nije dostupno.",
    retry: "Pokušaj ponovno",
  },

  firstOpen: {
    heading: "Prvo otvaranje",
    mac: "Apple još nije notarizirao Rail, pa ga macOS pri prvom otvaranju zaustavi. Otvori Postavke sustava, Privatnost i sigurnost, pomakni se do Raila i odaberi Svejedno otvori.",
    windows: "Windows SmartScreen može upozoriti na nepoznatog izdavača. Odaberi Više informacija, zatim Svejedno pokreni.",
  },
};

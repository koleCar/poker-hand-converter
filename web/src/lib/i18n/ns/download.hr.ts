import type { Dict } from "../types";

/** `/download` and the bar's "Get the app", Croatian. Same shape as `download.en.ts`. */
export const downloadHr: Dict["download"] = {
  metaTitle: "Preuzmi aplikaciju Rail za macOS i Windows | Rail",
  metaDescription:
    "Rail desktop tracker i HUD: uvozi svaku ruku dok igraš, prikazuje statistiku uživo na stolu i sinkronizira se s tvojim računom. Dio Rail Pro plana, za macOS i Windows.",

  getApp: "Preuzmi aplikaciju",
  getAppLabel: "Preuzmi desktop aplikaciju Rail",

  heading: "Rail na tvom računalu",
  lede: "Poker tracker i HUD koji radi uz tvoju poker sobu. Rail prati mapu s poviješću ruku, uvozi svaku ruku dok igraš, prikazuje statistiku uživo na stolu i drži tvoju biblioteku usklađenom s railom na webu.",
  promoAlt:
    "Desktop aplikacija Rail: poker stol s HUD statistikom iznad svakog sjedala, graf dobitka i uvoz novih ruku.",

  features: [
    {
      title: "Automatski uvoz",
      body: "Jednom pokaži Railu svoju poker sobu. Svaka nova ruka stiže u biblioteku nekoliko sekundi nakon što završi, a uvoze se i stare.",
    },
    {
      title: "HUD uživo",
      body: "VPIP, PFR, 3-bet i ostalo iznad svakog sjedala, u sobama čija pravila dopuštaju HUD.",
    },
    {
      title: "Replayer, izvještaji, analiza",
      body: "Prođi kroz bilo koju ruku, filtriraj rezultate po ulogu, poziciji i sesiji te vidi propuste poredane po izgubljenom EV-u.",
    },
    {
      title: "Tvoje, i bez interneta",
      body: "Ruke se spremaju na tvoje računalo i rade bez veze. Prijavi se da ih sinkroniziraš s webom i dijeliš na forumu.",
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

/**
 * The user's own preflop charts' words, Croatian. Same shape as
 * `charts.en.ts`.
 */

import type { chartsUiEn } from "./charts.en";
import { plural } from "./plural";

const num = (value: number) => value.toLocaleString("hr-HR");
const odluka = (count: number) => `${num(count)} ${plural(count, "odluka", "odluke", "odluka")}`;
const situacija = (count: number) => `${num(count)} ${plural(count, "situacija", "situacije", "situacija")}`;

export const chartsUiHr: typeof chartsUiEn = {
  title: "Tvoji preflop chartovi",
  intro:
    "Napravi ili uvezi svoje preflop rangeove, situaciju po situaciju, i vidi koliko ih ruke koje si odigrao prate. Tvoji chartovi vidljivi su samo tvom računu.",
  loading: "Učitavam tvoje chartove…",
  error: (reason) => `Tvoji chartovi se nisu učitali: ${reason}`,
  hiddenDuringPlay: "Tvoji chartovi skriveni su dok je otvoren poker stol: proučavaju se nakon igre.",

  library: {
    heading: "Setovi chartova",
    empty: "Još nemaš set chartova. Započni novi ili uvezi datoteku izvezenu iz Raila.",
    create: "Novi set chartova",
    newName: "Moj set chartova",
    open: (name) => `Otvori ${name}`,
    summary: (format, table, from, to, nodes) => `${format} · ${table} · ${num(from)}–${num(to)} bb · ${situacija(nodes)}`,
    updated: (when) => `Spremljeno ${when}`,
    importHeading: "Uvezi set chartova",
    importHelp: "Datoteka izvezena iz Raila (rail-preflop-charts JSON). Rangeovi iz drugih alata unose se situaciju po situaciju, u uređivaču.",
    importFile: "Odaberi datoteku",
    importPaste: "…ili zalijepi njezin tekst",
    importButton: "Uvezi",
    imported: (name) => `Uvezeno „${name}”. Provjeri pa spremi.`,
    limit: (max) => `Imaš ${num(max)} setova chartova, najviše što račun može držati. Obriši jedan da napraviš novi.`,
  },

  tabs: { label: "Set chartova", edit: "Uredi", compare: "Usporedi sa svojim rukama" },
  back: "Svi tvoji chartovi",

  game: {
    heading: "Igra",
    name: "Naziv",
    format: "Format",
    formats: { cash: "Cash", tournament: "Turnir" },
    table: "Stol",
    tables: { 2: "Heads-up", 6: "6-max (3–6 igrača)", 9: "Full ring (7–9 igrača)" },
    tablesShort: { 2: "Heads-up", 6: "6-max", 9: "Full ring" },
    stackFrom: "Stackovi od (bb)",
    stackTo: "do (bb)",
    tableChange: (count) =>
      `${situacija(count)} ne ${count === 1 ? "postoji" : "postoje"} za ovim stolom i ${count === 1 ? "bit će uklonjena" : "bit će uklonjene"} kad spremiš.`,
  },

  situation: {
    heading: "Situacija",
    scenario: "Spot",
    hero: "Ti si",
    villain: "Protiv",
    filled: "Popunjeno",
    none: "Još nijedna situacija nije popunjena: odaberi jednu gore i oboji mrežu.",
    scenarios: {
      rfi: "Otvaranje (prvi ulaziš)",
      "vs-limp": "Protiv limpera",
      "vs-open": "Protiv otvaranja",
      squeeze: "Protiv otvaranja i calla",
      "vs-iso": "Tvoj limp, protiv raisea",
      "vs-3bet": "Tvoje otvaranje, protiv 3-beta",
      "vs-4bet": "Tvoj 3-bet, protiv 4-beta",
      "vs-allin": "Tvoj 4-bet, protiv 5-beta",
    },
    label: (scenario, hero, villain) => {
      switch (scenario) {
        case "rfi":
          return `${hero} otvara`;
        case "vs-limp":
          return `${hero} protiv limpa s ${villain}`;
        case "vs-open":
          return `${hero} protiv otvaranja s ${villain}`;
        case "squeeze":
          return `${hero} protiv otvaranja s ${villain} i calla`;
        case "vs-iso":
          return `${hero} limpa, protiv raisea s ${villain}`;
        case "vs-3bet":
          return `${hero} otvara, protiv 3-beta s ${villain}`;
        case "vs-4bet":
          return `${hero} 3-beta, protiv 4-beta s ${villain}`;
        default:
          return `${hero} 4-beta, protiv 5-beta s ${villain}`;
      }
    },
  },

  actions: { raise: "Raise", call: "Call", allin: "All-in", fold: "Fold", check: "Check" },
  limp: "Limp",

  brush: {
    heading: "Kist",
    help: "Klikni ili povuci preko mreže da obojiš ruke ovom mješavinom; ostatak do 100 % je fold (check za big blind protiv limpera).",
    percent: (action) => `${action} %`,
    rest: (action, percent) => `${action} ${num(percent)} %`,
    presets: "Brze mješavine",
    over: "Mješavina je veća od 100 %.",
  },

  grid: {
    label: (situation) => `Chart za: ${situation}`,
    cell: (name, mix) => `${name}: ${mix}`,
    byRank: "Ruke s",
    byRankHelp: "Dodirni ruku da je obojiš kistom.",
    share: (action, percent) => `${action} ${percent} % ruku`,
  },

  tools: {
    undo: "Poništi",
    clear: "Očisti situaciju",
    copyFrom: "Kopiraj iz druge situacije",
    copy: "Kopiraj",
    copyRail: "Kreni od Railovog charta",
    copyRailHelp: "Railovi vlastiti chartovi iz solvera (ničiji drugi). Odaberi dubinu stacka.",
    railSetLabel: "Railov chart",
    railSet: (table, depth) => `${table} ${num(depth)} bb`,
    railMissing: "Railov chart nema tu situaciju na toj dubini.",
    copied: "Kopirano. Poništi vraća prethodno.",
    importText: "Zalijepi rangeove",
    importHelp:
      "Jedan range po akciji, kako ih pišu PIO, GTO+, Flopzilla ili Equilab: AA,AKs,A5s:0.5 · [50]KQo[/50] · AhKh:0.25 · jedna ruka po retku s težinom.",
    apply: "Primijeni na ovu situaciju",
    exportText: "Kopiraj kao tekst",
    exportFormat: "Format",
    exportFormats: { range: "Range (PIO, Flopzilla: AKs:0.5)", brackets: "GTO+ / Equilab ([50]…[/50])", combos: "Kombinacije (AhKh:0.5)" },
    save: "Spremi",
    saving: "Spremam…",
    saved: "Spremljeno.",
    unsaved: "Nespremljene promjene",
    download: "Preuzmi (Rail JSON)",
    delete: "Obriši set chartova",
    deleteConfirm: (name) => `Obrisati „${name}”? To se ne može poništiti.`,
    raiseSize: "Tvoja veličina raisea ovdje (bb, neobavezno)",
  },

  problems: {
    name: "Daj setu chartova naziv (do 80 znakova).",
    "stack-range": "Raspon stackova mora biti od 1 do 1.000 bb, od nižeg prema višem.",
    "too-many-nodes": "Set chartova drži najviše 300 situacija.",
    "node-key": (detail) => `Nije situacija ovog stola: ${detail}`,
    "action-not-allowed": (detail) => `Nije akcija ove situacije: ${detail}`,
    percent: (detail) => `Postotak je veći od 100: ${detail}`,
    "over-100": (detail) => `Akcije ruke zajedno prelaze 100 %: ${detail}`,
    "raise-size": (detail) => `Veličina raisea mora biti između 0 i 1.000 bb: ${detail}`,
    "too-big": "Set chartova je prevelik za spremanje.",
    json: (detail) => `Nije JSON datoteka: ${detail}`,
    format: "Nije Railova datoteka chartova (rail-preflop-charts).",
    version: (detail) => `Railova datoteka chartova verzije koju ova stranica ne čita: ${detail}`,
    game: "Igra u datoteci (format, veličina stola, raspon stackova) nije ona za koju Rail ima chartove.",
    duplicate: (detail) => `Datoteka dvaput navodi situaciju: ${detail}`,
    range: (where, detail) => `${where}: ne mogu pročitati ${detail}`,
    set: (detail) => detail,
  },

  compare: {
    heading: "Tvoje ruke prema ovom chartu",
    period: "Razdoblje",
    periods: { "30d": "30 dana", "90d": "90 dana", "365d": "Godina", all: "Sve" },
    periodNote: (from, to) => `Tvoje preflop odluke od ${from} do ${to}, unatrag od posljednje.`,
    loading: "Uspoređujem…",
    nothing:
      "Još nijedna tvoja analizirana preflop odluka ne odgovara igri ovog charta. Analiziraj ruke na stranici Analiza; turnirske ruke analiza još ne čita.",
    scope:
      "Uspoređeno: preflop odluke koje je analiza smjestila na Railovo stablo chartova (cash no-limit hold'em, 2–9 igrača, stackovi koje pokriva), u formatu, veličini stola i rasponu stackova ovog charta.",
    tiles: {
      decisions: "Uspoređenih odluka",
      followed: "Odigrano po tvom chartu",
      off: "Izvan tvog charta",
      cost: "Njihov EV po Railovim chartovima",
    },
    followedValue: (percent) => `${percent} %`,
    costValue: (bb) => `−${bb} bb`,
    costNote: "Tvoj chart nema EV: ovo je koliko odstupanja koštaju po Railovim chartovima.",
    situations: "Po situacijama",
    columns: { situation: "Situacija", decisions: "Odluke", followed: "Po tvom chartu", top: "Najčešće odstupanje" },
    deviation: (hand, action, count) => `${hand} ${action} ×${num(count)}`,
    noDeviation: "—",
    missing: (count) =>
      `${situacija(count)} ${count === 1 ? "koju si igrao nije" : "koje si igrao nisu"} u ovom chartu:`,
    missingItem: (situation, count) => `${situation} (${odluka(count)})`,
    fill: "Popuni je",
    unnamed: (count) =>
      `${odluka(count)} ${count === 1 ? "je bila" : "su bile"} u spotovima koje chartovi ne imenuju (hladni 4-bet, reraise pot s callerom, nakon iso-raisea) i ${count === 1 ? "nije uspoređena" : "nisu uspoređene"}.`,
    detail: {
      heading: (situation) => `${situation}: tvoja igra`,
      mix: "Tvoje akcije prema chartu, za ruke koje si imao",
      mixRow: (action, played, chart) => `${action}: ti ${played} %, chart ${chart} %`,
      grid: "Ruke izvan charta su označene; mreža je tvoj chart.",
      deviations: "Odstupanja",
      none: "Svaka odluka ovdje prati tvoj chart.",
      row: (hand, did, count, does, percent) =>
        `${hand}: ${did} ×${num(count)} - tvoj chart ${does} (tvoju akciju igra ${percent} %)`,
      did: { raise: "raiseao si", call: "callao si", allin: "išao si all-in", fold: "foldao si", check: "checkao si" },
      does: { raise: "raisea", call: "calla", allin: "ide all-in", fold: "folda", check: "checka" },
      examples: "Primjeri ruku",
      examplesFor: (hand, did) => `${hand}, ${did}`,
      noExamples: "Nema ruke za prikaz.",
      open: (cards, when) => `Otvori ${cards} od ${when} na odluci`,
      evLoss: (bb) => `−${bb} bb EV po Railovim chartovima`,
    },
  },
};

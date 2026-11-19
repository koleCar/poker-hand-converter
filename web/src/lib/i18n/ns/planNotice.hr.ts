import type { Dict } from "../types";

/** Odbijanja plana i Free ograničenje (Rail R6.4). Same shape as `planNotice.en.ts`. */
export const planNoticeHr: Dict["planNotice"] = {
  prompt: {
    heading: "Ovo je Pro značajka",
    generic: "Tvoj plan ovo ne uključuje.",
    capHeading: "Biblioteka ti je puna",
    cap: (cap) => `Free plan drži ${cap} ruku. Prijeđi na Pro da nastaviš spremati ruke.`,
    dailyHeading: "Današnje ruke su spremljene",
    daily: (cap) => `Danas je spremljeno ${cap} ruku — ostale se spremaju nakon resetiranja, ili odmah uz Pro.`,
    upgrade: "Pogledaj Pro",
    dismiss: "Ne sada",
  },
  converter: {
    capNear: (left, cap) => `U tvojoj biblioteci na Free planu ima mjesta za još ${left} ruku (drži ${cap}).`,
    capFull: (cap) => `Biblioteka ti je puna (${cap} ruku na Free planu).`,
    daily: (cap) => `Danas je spremljeno ${cap} ruku — ostale se spremaju nakon resetiranja, ili odmah uz Pro.`,
    trimmed: "Spremljene su samo ruke koje stanu u tvoju Free biblioteku.",
    pausedCap: (cap) => `Biblioteka ti je puna (${cap} ruku na Free planu). Spremljena je svaka ruka koja je stala.`,
    pausedPlan: "Spremanje je zaustavljeno: tvoj plan to ne dopušta.",
    upgrade: "Pogledaj Pro",
  },
};

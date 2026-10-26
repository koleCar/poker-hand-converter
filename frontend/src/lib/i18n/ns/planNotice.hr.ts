import type { Dict } from "../types";

/** Odbijanja plana i Free ograničenje (Rail R6.4). Same shape as `planNotice.en.ts`. */
export const planNoticeHr: Dict["planNotice"] = {
  prompt: {
    heading: "Ovo je Pro značajka",
    generic: "Tvoj plan ovo ne uključuje.",
    capHeading: "Biblioteka ti je puna",
    cap: (cap) => `Free plan drži ${cap} ruku. Prijeđi na Pro da nastaviš spremati ruke.`,
    upgrade: "Prijeđi na Pro",
    dismiss: "Ne sada",
  },
  converter: {
    capNear: (left, cap) => `U tvojoj biblioteci na Free planu ima mjesta za još ${left} ruku (drži ${cap}).`,
    capFull: (cap) => `Biblioteka ti je puna: Free plan drži ${cap} ruku. Nove ruke se ne spremaju dok ne prijeđeš na Pro.`,
    trimmed: "Spremljene su samo ruke koje stanu u tvoju Free biblioteku.",
    pausedCap: (cap) =>
      `Spremanje je zaustavljeno: biblioteka ti je puna na Free planu (${cap} ruku). Spremljena je svaka ruka koja je stala; ostale čekaju u ovoj kartici. Prijeđi na Pro pa pokušaj ponovno.`,
    pausedPlan: "Spremanje je zaustavljeno: tvoj plan to ne dopušta. Prijeđi na Pro pa pokušaj ponovno.",
    upgrade: "Prijeđi na Pro",
  },
};

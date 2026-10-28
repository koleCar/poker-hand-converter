// Made-up player names: the table simulator's word lists and patterns
// (hud/rail-hud-sim/src/names.rs) - ASCII, no spaces, a digit or `_` in
// each, so none is an ordinary word of a hand history - from a seeded
// generator, so the same corpus always gets the same cast.

const FIRST = [
  'Silent', 'Lucky', 'River', 'Turbo', 'Quiet', 'Grumpy', 'Shady', 'Mighty', 'Lazy', 'Brave',
  'Crafty', 'Dizzy', 'Frosty', 'Golden', 'Hasty', 'Jolly', 'Keen', 'Lofty', 'Moody', 'Nifty',
  'Plucky', 'Rusty', 'Salty', 'Tipsy', 'Witty', 'Zesty', 'Bluff', 'Snappy', 'Gritty', 'Sneaky',
  'Wobbly', 'Cosmic',
];

// names.rs's second list without Fish, Donk, Whale and Shark: on a panel or
// in a list they would read as the user's own label for the player.
const SECOND = [
  'Rat', 'Owl', 'Tiger', 'Mole', 'Crab', 'Fox', 'Bear', 'Hawk', 'Badger', 'Otter', 'Panda',
  'Moose', 'Gecko', 'Llama', 'Raven', 'Bison', 'Cobra', 'Lynx', 'Mantis', 'Newt', 'Pike', 'Quail',
  'Squid', 'Toad', 'Viper', 'Wasp', 'Yak', 'Zebu',
];

/** mulberry32: small, seeded, the same sequence on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class NameSource {
  private used = new Set<string>();
  private next: () => number;

  constructor(seed: number) {
    this.next = rng(seed);
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }

  private between(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** A name nobody else has, and none of `avoid`. */
  fresh(avoid: Set<string>): string {
    for (;;) {
      const first = this.pick(FIRST);
      const second = this.pick(SECOND);
      const kind = Math.floor(this.next() * 3);
      const name =
        kind === 0
          ? `${first}${second}${this.between(1, 99)}`
          : kind === 1
            ? `${first.toLowerCase()}_${second}${this.between(1, 9)}`
            : `${second}_${first}${this.between(10, 999)}`;
      if (!this.used.has(name) && !avoid.has(name)) {
        this.used.add(name);
        return name;
      }
    }
  }

  reserve(name: string): void {
    this.used.add(name);
  }
}

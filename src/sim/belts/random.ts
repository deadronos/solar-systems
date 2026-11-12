/** Small deterministic PRNG (mulberry32) so belts are reproducible across reloads. */
export interface Rng {
  next(): number;
  uniform(min: number, max: number): number;
  gaussian(mean?: number, sigma?: number): number;
  rayleigh(sigma: number): number;
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    uniform: (min, max) => min + (max - min) * next(),
    gaussian: (mean = 0, sigma = 1) => {
      const u = 1 - next();
      const v = next();
      return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    rayleigh: (sigma) => sigma * Math.sqrt(-2 * Math.log(1 - next())),
  };
}

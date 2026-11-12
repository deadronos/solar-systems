import { createRng, type Rng } from './random.ts';
import { ParticleOrbits } from './particles.ts';

export interface BeltDefinition {
  id: string;
  name: string;
  description: string;
  count: number;
  seed: number;
  /** Fill particle `k` with sampled elements (AU / degrees). */
  sample(orbits: ParticleOrbits, k: number, rng: Rng): void;
}

export interface Belt {
  readonly def: BeltDefinition;
  readonly orbits: ParticleOrbits;
}

export function createBelt(def: BeltDefinition): Belt {
  const orbits = new ParticleOrbits(def.count);
  const rng = createRng(def.seed);
  for (let k = 0; k < def.count; k++) def.sample(orbits, k, rng);
  return { def, orbits };
}

const angle = (rng: Rng): number => rng.uniform(0, 360);

/** Kirkwood gaps: mean-motion resonances with Jupiter (AU, half-width AU). */
const KIRKWOOD_GAPS: readonly (readonly [number, number])[] = [
  [2.065, 0.02], // 4:1
  [2.502, 0.025], // 3:1
  [2.825, 0.02], // 5:2
  [2.958, 0.015], // 7:3
  [3.279, 0.04], // 2:1
];

function sampleMainBeltA(rng: Rng): number {
  for (;;) {
    // Population is concentrated in 2.2–3.2 AU, slightly denser in the inner/middle belt.
    const a = rng.gaussian(2.7, 0.28);
    if (a < 2.1 || a > 3.35) continue;
    let keep = 1;
    for (const [gap, w] of KIRKWOOD_GAPS) keep *= 1 - Math.exp(-(((a - gap) / w) ** 2));
    if (rng.next() < keep) return a;
  }
}

/** Jupiter's J2000 mean longitude and longitude of perihelion (deg), from the JPL table. */
const JUPITER_L0 = 34.396_440_51;
const JUPITER_A_AU = 5.202_887;

/**
 * Statistical belt models. Individual particles are synthetic, but their orbital element
 * distributions follow the observed populations, and each is propagated with real
 * Keplerian motion (inner particles orbit faster than outer ones).
 */
export const DEFAULT_BELTS: readonly BeltDefinition[] = [
  {
    id: 'main-belt',
    name: 'Main asteroid belt',
    description: '2.1–3.3 AU, with Kirkwood gaps at the 4:1, 3:1, 5:2, 7:3 and 2:1 resonances',
    count: 14_000,
    seed: 1,
    sample: (o, k, rng) => {
      o.set(
        k,
        sampleMainBeltA(rng),
        Math.min(rng.rayleigh(0.09), 0.4),
        Math.min(rng.rayleigh(8), 40),
        angle(rng),
        angle(rng),
        angle(rng),
      );
    },
  },
  {
    id: 'hildas',
    name: 'Hilda group',
    description: '3:2 resonance with Jupiter at ~4.0 AU',
    count: 1_200,
    seed: 2,
    sample: (o, k, rng) => {
      // Hildas reach aphelion near Jupiter's L3, L4 and L5 directions, forming a triangle
      // that co-rotates with Jupiter thanks to the 3:2 period ratio.
      const lobe = Math.floor(rng.next() * 3);
      const lambda = JUPITER_L0 + 60 + lobe * 120 + rng.gaussian(0, 12);
      const M0 = 180 + rng.gaussian(0, 25);
      const varpi = lambda - M0;
      const Omega = angle(rng);
      const a = JUPITER_A_AU * (2 / 3) ** (2 / 3) + rng.gaussian(0, 0.02);
      o.set(k, a, rng.uniform(0.1, 0.3), rng.rayleigh(7), Omega, varpi - Omega, M0);
    },
  },
  {
    id: 'jupiter-trojans',
    name: 'Jupiter trojans',
    description: 'Co-orbital swarms at Jupiter’s L4 (leading) and L5 (trailing) points',
    count: 4_000,
    seed: 3,
    sample: (o, k, rng) => {
      const leading = rng.next() < 0.6; // L4 is ~1.6× more populous
      const lambda = JUPITER_L0 + (leading ? 60 : -60) + rng.gaussian(0, 12);
      const Omega = angle(rng);
      const omega = angle(rng);
      const M0 = lambda - Omega - omega;
      o.set(
        k,
        JUPITER_A_AU + rng.gaussian(0, 0.05),
        Math.min(rng.rayleigh(0.07), 0.25),
        Math.min(rng.rayleigh(12), 40),
        Omega,
        omega,
        M0,
      );
    },
  },
  {
    id: 'kuiper-belt',
    name: 'Kuiper belt',
    description: 'Plutinos (39.4 AU), hot & cold classical belt (42–48 AU)',
    count: 9_000,
    seed: 4,
    sample: (o, k, rng) => {
      const r = rng.next();
      if (r < 0.25) {
        // Plutinos: 3:2 resonance with Neptune.
        o.set(
          k,
          rng.gaussian(39.4, 0.2),
          rng.uniform(0.1, 0.3),
          rng.rayleigh(10),
          angle(rng),
          angle(rng),
          angle(rng),
        );
      } else if (r < 0.6) {
        // Cold classical: low e, low i, 42–47 AU.
        o.set(
          k,
          rng.uniform(42.5, 47),
          rng.rayleigh(0.04),
          rng.rayleigh(2),
          angle(rng),
          angle(rng),
          angle(rng),
        );
      } else {
        // Hot classical.
        o.set(
          k,
          rng.uniform(40, 48),
          Math.min(rng.rayleigh(0.1), 0.25),
          rng.rayleigh(14),
          angle(rng),
          angle(rng),
          angle(rng),
        );
      }
    },
  },
  {
    id: 'scattered-disc',
    name: 'Scattered disc',
    description: 'High-eccentricity TNOs with perihelia near Neptune and a ≈ 50–150 AU',
    count: 1_500,
    seed: 5,
    sample: (o, k, rng) => {
      const a = 50 * Math.exp(rng.next() * Math.log(3)); // 50–150 AU, log-uniform
      const q = rng.uniform(32, 40);
      o.set(k, a, 1 - q / a, rng.rayleigh(18), angle(rng), angle(rng), angle(rng));
    },
  },
];

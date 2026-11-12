import { heliocentric } from '../orbits/models.ts';
import type { BodyDefinition } from './types.ts';

/**
 * Dwarf planets and the largest asteroids.
 * Elements are osculating heliocentric J2000-ecliptic elements at the given epoch
 * (rounded from JPL SBDB); propagated as unperturbed two-body orbits, so accuracy
 * degrades slowly away from the epoch.
 */
export const MINOR_BODIES: readonly BodyDefinition[] = [
  {
    id: 'pluto',
    name: 'Pluto',
    kind: 'dwarf-planet',
    parentId: 'sun',
    radiusKm: 1_188.3,
    gm: 869.6,
    orbit: {
      kind: 'jplApprox',
      elements: [
        39.482_116_75, 0.248_827_3, 17.140_012_06, 238.929_038_33, 224.068_916_29, 110.303_936_84,
      ],
      rates: [
        -0.000_315_96, 0.000_051_7, 0.000_048_18, 145.207_805_15, -0.040_629_42, -0.011_834_82,
      ],
    },
    // IAU positive pole; rotation is synchronous with Charon's orbit.
    rotation: { poleRaDeg: 132.993, poleDecDeg: -6.163, periodHours: 153.293_5, W0Deg: 302.695 },
  },
  {
    id: 'ceres',
    name: 'Ceres',
    kind: 'dwarf-planet',
    parentId: 'sun',
    radiusKm: 469.7,
    gm: 62.63,
    orbit: heliocentric({
      epochJd: 2_460_600.5,
      aAU: 2.7656,
      e: 0.0796,
      iDeg: 10.588,
      OmegaDeg: 80.25,
      omegaDeg: 73.3,
      M0Deg: 145.7,
    }),
    rotation: { poleRaDeg: 291.418, poleDecDeg: 66.764, periodHours: 9.074_17 },
  },
  {
    id: 'vesta',
    name: 'Vesta',
    kind: 'asteroid',
    parentId: 'sun',
    radiusKm: 262.7,
    orbit: heliocentric({
      epochJd: 2_460_600.5,
      aAU: 2.3615,
      e: 0.0894,
      iDeg: 7.144,
      OmegaDeg: 103.71,
      omegaDeg: 151.66,
      M0Deg: 278.7,
    }),
    rotation: { poleRaDeg: 309.031, poleDecDeg: 42.235, periodHours: 5.342 },
  },
  {
    id: 'pallas',
    name: 'Pallas',
    kind: 'asteroid',
    parentId: 'sun',
    radiusKm: 256,
    orbit: heliocentric({
      epochJd: 2_460_600.5,
      aAU: 2.7703,
      e: 0.2304,
      iDeg: 34.93,
      OmegaDeg: 172.88,
      omegaDeg: 310.93,
      M0Deg: 60,
    }),
  },
  {
    id: 'hygiea',
    name: 'Hygiea',
    kind: 'asteroid',
    parentId: 'sun',
    radiusKm: 216.5,
    orbit: heliocentric({
      epochJd: 2_460_600.5,
      aAU: 3.1407,
      e: 0.1077,
      iDeg: 3.83,
      OmegaDeg: 283.14,
      omegaDeg: 312.5,
      M0Deg: 100,
    }),
  },
  {
    id: 'haumea',
    name: 'Haumea',
    kind: 'dwarf-planet',
    parentId: 'sun',
    radiusKm: 780,
    orbit: heliocentric({
      epochJd: 2_459_000.5,
      aAU: 43.12,
      e: 0.1949,
      iDeg: 28.21,
      OmegaDeg: 122.17,
      omegaDeg: 239.04,
      M0Deg: 218.2,
    }),
  },
  {
    id: 'makemake',
    name: 'Makemake',
    kind: 'dwarf-planet',
    parentId: 'sun',
    radiusKm: 715,
    orbit: heliocentric({
      epochJd: 2_459_000.5,
      aAU: 45.43,
      e: 0.1613,
      iDeg: 28.98,
      OmegaDeg: 79.62,
      omegaDeg: 294.84,
      M0Deg: 165.5,
    }),
  },
  {
    id: 'eris',
    name: 'Eris',
    kind: 'dwarf-planet',
    parentId: 'sun',
    radiusKm: 1_163,
    gm: 1_108,
    orbit: heliocentric({
      epochJd: 2_459_000.5,
      aAU: 67.86,
      e: 0.4361,
      iDeg: 44.04,
      OmegaDeg: 35.95,
      omegaDeg: 151.64,
      M0Deg: 205.99,
    }),
  },
  {
    id: 'sedna',
    name: 'Sedna',
    kind: 'dwarf-planet',
    parentId: 'sun',
    radiusKm: 500,
    orbit: heliocentric({
      epochJd: 2_459_000.5,
      aAU: 506,
      e: 0.8496,
      iDeg: 11.93,
      OmegaDeg: 144.25,
      omegaDeg: 311.35,
      M0Deg: 358.1,
    }),
  },
];

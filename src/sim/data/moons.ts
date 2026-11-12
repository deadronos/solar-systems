import { J2000 } from '../constants.ts';
import type { MeanElementsOrbit } from '../orbits/models.ts';
import type { BodyDefinition, OrbitFrame } from './types.ts';

interface MoonSpec {
  id: string;
  name: string;
  parentId: string;
  radiusKm: number;
  /** [a (km), e, i (deg), ω (deg), Ω (deg), M0 (deg), sidereal period (days)] */
  el: readonly [number, number, number, number, number, number, number];
  frame?: OrbitFrame;
  OmegaRateDegPerDay?: number;
  omegaRateDegPerDay?: number;
  synchronous?: boolean;
}

function moon(spec: MoonSpec): BodyDefinition {
  const [aKm, e, iDeg, omegaDeg, OmegaDeg, M0Deg, periodDays] = spec.el;
  const orbit: MeanElementsOrbit = {
    kind: 'meanElements',
    epochJd: J2000,
    aKm,
    e,
    iDeg,
    OmegaDeg,
    omegaDeg,
    M0Deg,
    periodDays,
    ...(spec.OmegaRateDegPerDay === undefined
      ? {}
      : { OmegaRateDegPerDay: spec.OmegaRateDegPerDay }),
    ...(spec.omegaRateDegPerDay === undefined
      ? {}
      : { omegaRateDegPerDay: spec.omegaRateDegPerDay }),
  };
  return {
    id: spec.id,
    name: spec.name,
    kind: 'moon',
    parentId: spec.parentId,
    radiusKm: spec.radiusKm,
    orbit,
    orbitFrame: spec.frame ?? 'parentEquator',
    ...(spec.synchronous === false ? {} : { rotation: 'synchronous' as const }),
  };
}

/**
 * Major moons. Mean orbital elements at J2000 (JPL SSD planetary satellite mean elements,
 * rounded). Most are referenced to the parent's equator; the Moon and distant irregulars
 * use the ecliptic. Phases of the smaller moons are approximate.
 */
export const MOONS: readonly BodyDefinition[] = [
  // Earth — the Moon's node regresses with an 18.6 yr period, perigee advances in 8.85 yr.
  moon({
    id: 'moon',
    name: 'Moon',
    parentId: 'earth',
    radiusKm: 1_737.4,
    el: [384_400, 0.0554, 5.16, 318.15, 125.08, 135.27, 27.321_661],
    frame: 'ecliptic',
    OmegaRateDegPerDay: -360 / 6_793.48,
    omegaRateDegPerDay: 360 / 3_232.6 + 360 / 6_793.48,
  }),

  // Mars
  moon({
    id: 'phobos',
    name: 'Phobos',
    parentId: 'mars',
    radiusKm: 11.27,
    el: [9_376, 0.0151, 1.075, 150.247, 207.784, 91.059, 0.318_910_2],
  }),
  moon({
    id: 'deimos',
    name: 'Deimos',
    parentId: 'mars',
    radiusKm: 6.2,
    el: [23_458, 0.0002, 1.788, 290.496, 24.525, 296.23, 1.262_44],
  }),

  // Jupiter — Galilean moons
  moon({
    id: 'io',
    name: 'Io',
    parentId: 'jupiter',
    radiusKm: 1_821.6,
    el: [421_800, 0.0041, 0.036, 84.129, 43.977, 342.021, 1.769_137_786],
  }),
  moon({
    id: 'europa',
    name: 'Europa',
    parentId: 'jupiter',
    radiusKm: 1_560.8,
    el: [671_100, 0.0094, 0.466, 88.97, 219.106, 171.016, 3.551_181_041],
  }),
  moon({
    id: 'ganymede',
    name: 'Ganymede',
    parentId: 'jupiter',
    radiusKm: 2_634.1,
    el: [1_070_400, 0.0013, 0.177, 192.417, 63.552, 317.54, 7.154_552_96],
  }),
  moon({
    id: 'callisto',
    name: 'Callisto',
    parentId: 'jupiter',
    radiusKm: 2_410.3,
    el: [1_882_700, 0.0074, 0.192, 52.643, 298.848, 181.408, 16.689_018_4],
  }),

  // Saturn
  moon({
    id: 'mimas',
    name: 'Mimas',
    parentId: 'saturn',
    radiusKm: 198.2,
    el: [185_539, 0.0196, 1.574, 332.499, 173.027, 14.848, 0.942_421_813],
  }),
  moon({
    id: 'enceladus',
    name: 'Enceladus',
    parentId: 'saturn',
    radiusKm: 252.1,
    el: [238_042, 0.0047, 0.003, 0.076, 342.507, 199.686, 1.370_217_855],
  }),
  moon({
    id: 'tethys',
    name: 'Tethys',
    parentId: 'saturn',
    radiusKm: 531.1,
    el: [294_672, 0.0001, 1.091, 45.202, 259.842, 243.367, 1.887_802_16],
  }),
  moon({
    id: 'dione',
    name: 'Dione',
    parentId: 'saturn',
    radiusKm: 561.4,
    el: [377_415, 0.0022, 0.028, 284.315, 290.415, 322.232, 2.736_915_58],
  }),
  moon({
    id: 'rhea',
    name: 'Rhea',
    parentId: 'saturn',
    radiusKm: 763.8,
    el: [527_068, 0.0002, 0.333, 241.619, 351.042, 179.781, 4.517_500_436],
  }),
  moon({
    id: 'titan',
    name: 'Titan',
    parentId: 'saturn',
    radiusKm: 2_574.7,
    el: [1_221_865, 0.0288, 0.306, 180.532, 28.06, 163.31, 15.945_448],
  }),
  moon({
    id: 'hyperion',
    name: 'Hyperion',
    parentId: 'saturn',
    radiusKm: 135,
    el: [1_500_933, 0.0232, 0.615, 303.178, 263.847, 86.342, 21.276_658_7],
    synchronous: false,
  }),
  moon({
    id: 'iapetus',
    name: 'Iapetus',
    parentId: 'saturn',
    radiusKm: 734.5,
    el: [3_560_854, 0.0293, 15.47, 271.606, 81.105, 201.789, 79.330_183],
  }),

  // Uranus
  moon({
    id: 'miranda',
    name: 'Miranda',
    parentId: 'uranus',
    radiusKm: 235.8,
    el: [129_900, 0.0013, 4.338, 68.312, 326.438, 311.33, 1.413_479_25],
  }),
  moon({
    id: 'ariel',
    name: 'Ariel',
    parentId: 'uranus',
    radiusKm: 578.9,
    el: [190_900, 0.0012, 0.041, 115.349, 22.394, 39.481, 2.520_379_052],
  }),
  moon({
    id: 'umbriel',
    name: 'Umbriel',
    parentId: 'uranus',
    radiusKm: 584.7,
    el: [266_000, 0.0039, 0.128, 84.709, 33.485, 12.469, 4.144_176_46],
  }),
  moon({
    id: 'titania',
    name: 'Titania',
    parentId: 'uranus',
    radiusKm: 788.9,
    el: [436_300, 0.0011, 0.079, 284.4, 99.771, 24.614, 8.705_866_93],
  }),
  moon({
    id: 'oberon',
    name: 'Oberon',
    parentId: 'uranus',
    radiusKm: 761.4,
    el: [583_500, 0.0014, 0.068, 104.4, 279.771, 283.088, 13.463_234],
  }),

  // Neptune — Triton is retrograde (i > 90°).
  moon({
    id: 'proteus',
    name: 'Proteus',
    parentId: 'neptune',
    radiusKm: 210,
    el: [117_647, 0.0005, 0.524, 301.706, 162.69, 117.05, 1.122_315_47],
  }),
  moon({
    id: 'triton',
    name: 'Triton',
    parentId: 'neptune',
    radiusKm: 1_353.4,
    el: [354_759, 0.000_016, 156.865, 66.142, 177.608, 352.257, 5.876_854_07],
  }),
  moon({
    id: 'nereid',
    name: 'Nereid',
    parentId: 'neptune',
    radiusKm: 170,
    el: [5_513_818, 0.7507, 7.09, 281.117, 335.57, 318.064, 360.13],
    frame: 'ecliptic',
    synchronous: false,
  }),

  // Pluto
  moon({
    id: 'charon',
    name: 'Charon',
    parentId: 'pluto',
    radiusKm: 606,
    el: [19_591, 0.0002, 0.08, 146.106, 26.928, 131.07, 6.387_230_4],
  }),
];

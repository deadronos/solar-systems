import type { BodyDefinition } from './types.ts';

/**
 * Sun and the eight major planets.
 * Orbits: JPL approximate Keplerian elements (Standish, Table 1, 1800–2050 AD).
 * Radii / flattening: IAU WGCCRE 2015 & NASA fact sheets.
 * Poles: IAU WGCCRE 2015 (positive pole, see RotationModel).
 */
export const SUN: BodyDefinition = {
  id: 'sun',
  name: 'Sun',
  kind: 'star',
  parentId: null,
  radiusKm: 695_700,
  gm: 1.327_124_400_18e11,
  rotation: { poleRaDeg: 286.13, poleDecDeg: 63.87, periodHours: 609.12, W0Deg: 84.176 },
};

export const PLANETS: readonly BodyDefinition[] = [
  {
    id: 'mercury',
    name: 'Mercury',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 2_439.7,
    gm: 22_031.86,
    orbit: {
      kind: 'jplApprox',
      elements: [
        0.387_099_27, 0.205_635_93, 7.004_979_02, 252.250_323_5, 77.457_796_28, 48.330_765_93,
      ],
      rates: [
        0.000_000_37, 0.000_019_06, -0.005_947_49, 149_472.674_111_75, 0.160_476_89, -0.125_340_81,
      ],
    },
    rotation: { poleRaDeg: 281.0103, poleDecDeg: 61.4155, periodHours: 1_407.6, W0Deg: 329.5988 },
  },
  {
    id: 'venus',
    name: 'Venus',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 6_051.8,
    gm: 324_858.59,
    orbit: {
      kind: 'jplApprox',
      elements: [
        0.723_335_66, 0.006_776_72, 3.394_676_05, 181.979_099_5, 131.602_467_18, 76.679_842_55,
      ],
      rates: [
        0.000_003_9, -0.000_041_07, -0.000_788_9, 58_517.815_387_29, 0.002_683_29, -0.277_694_18,
      ],
    },
    // Retrograde: positive pole is opposite the IAU north pole (272.76, 67.16).
    rotation: { poleRaDeg: 92.76, poleDecDeg: -67.16, periodHours: 5_832.6, W0Deg: 160.2 },
  },
  {
    id: 'earth',
    name: 'Earth',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 6_371.0,
    flattening: 0.003_352_8,
    gm: 398_600.435,
    // Earth–Moon barycenter elements; the ~4,700 km offset to Earth's center is ignored.
    orbit: {
      kind: 'jplApprox',
      elements: [1.000_002_61, 0.016_711_23, -0.000_015_31, 100.464_571_66, 102.937_681_93, 0],
      rates: [0.000_005_62, -0.000_043_92, -0.012_946_68, 35_999.372_449_81, 0.323_273_64, 0],
    },
    rotation: { poleRaDeg: 0, poleDecDeg: 90, periodHours: 23.934_469_6, W0Deg: 190.147 },
  },
  {
    id: 'mars',
    name: 'Mars',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 3_389.5,
    flattening: 0.005_89,
    gm: 42_828.37,
    orbit: {
      kind: 'jplApprox',
      elements: [
        1.523_710_34, 0.093_394_1, 1.849_691_42, -4.553_432_05, -23.943_629_59, 49.559_538_91,
      ],
      rates: [
        0.000_018_47, 0.000_078_82, -0.008_131_31, 19_140.302_684_99, 0.444_410_88, -0.292_573_43,
      ],
    },
    rotation: {
      poleRaDeg: 317.681_43,
      poleDecDeg: 52.886_5,
      periodHours: 24.622_962,
      W0Deg: 176.63,
    },
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 69_911,
    flattening: 0.064_87,
    gm: 126_686_534,
    orbit: {
      kind: 'jplApprox',
      elements: [
        5.202_887, 0.048_386_24, 1.304_396_95, 34.396_440_51, 14.728_479_83, 100.473_909_09,
      ],
      rates: [
        -0.000_116_07, -0.000_132_53, -0.001_837_14, 3_034.746_127_75, 0.212_526_68, 0.204_691_06,
      ],
    },
    rotation: {
      poleRaDeg: 268.056_595,
      poleDecDeg: 64.495_303,
      periodHours: 9.925_5,
      W0Deg: 284.95,
    },
  },
  {
    id: 'saturn',
    name: 'Saturn',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 58_232,
    flattening: 0.097_96,
    gm: 37_931_187,
    orbit: {
      kind: 'jplApprox',
      elements: [
        9.536_675_94, 0.053_861_79, 2.485_991_87, 49.954_244_23, 92.598_878_31, 113.662_424_48,
      ],
      rates: [
        -0.001_250_6, -0.000_509_91, 0.001_936_09, 1_222.493_622_01, -0.418_972_16, -0.288_677_94,
      ],
    },
    rotation: { poleRaDeg: 40.589, poleDecDeg: 83.537, periodHours: 10.656_222, W0Deg: 38.9 },
  },
  {
    id: 'uranus',
    name: 'Uranus',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 25_362,
    flattening: 0.022_93,
    gm: 5_793_939,
    orbit: {
      kind: 'jplApprox',
      elements: [
        19.189_164_64, 0.047_257_44, 0.772_637_83, 313.238_104_51, 170.954_276_3, 74.016_925_03,
      ],
      rates: [
        -0.001_961_76, -0.000_043_97, -0.002_429_39, 428.482_027_85, 0.408_052_81, 0.042_405_89,
      ],
    },
    // Retrograde: positive pole is opposite the IAU north pole (257.311, −15.175).
    rotation: { poleRaDeg: 77.311, poleDecDeg: 15.175, periodHours: 17.24, W0Deg: 203.81 },
  },
  {
    id: 'neptune',
    name: 'Neptune',
    kind: 'planet',
    parentId: 'sun',
    radiusKm: 24_622,
    flattening: 0.017_08,
    gm: 6_836_529,
    orbit: {
      kind: 'jplApprox',
      elements: [
        30.069_922_76, 0.008_590_48, 1.770_043_47, -55.120_029_69, 44.964_762_27, 131.784_225_74,
      ],
      rates: [
        0.000_262_91, 0.000_051_05, 0.000_353_72, 218.459_453_25, -0.322_414_64, -0.005_086_64,
      ],
    },
    rotation: { poleRaDeg: 299.36, poleDecDeg: 43.46, periodHours: 16.11, W0Deg: 249.978 },
  },
];
